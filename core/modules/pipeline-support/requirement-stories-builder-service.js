/* eslint-disable */
/**
 * RequirementStoriesBuilderService — 需求阶段结构化 User Story Builder
 *
 * 故事线（AGENTS.md "确定事实不进 LLM 视野" + r2c 模式）：
 *   设计阶段 LLM 反复传 storyId / userStory / acceptanceCriteria / invariants 失败的真根因，
 *   是这些字段在需求阶段只落到 需求分析.md（人读展示稿），机器消费时拿不到结构化版本。
 *   这里加一份 stories.json 作为机器合同：LLM 在需求阶段把业务判断消化进
 *   analysis-state.json.stories；Builder 从 canonical analysis-state 物化 stories.json + receipt
 *   （含 hash）。req_stories_submit 不接收 stories[] 入参；storyIds 以 stories.json 为唯一真值源。
 *
 *   设计阶段 design Builder 直接从 stories.json 按 storyId join 读 userStory / acceptanceCriteria
 *   / invariants，不再让 LLM 重传——这些字段是确定事实，归 Builder。
 *
 * 入参形状（新主线）：
 * {
 *   projectPath,
 *   paths: { storiesPath, storiesReceiptPath, analysisStatePath }
 * }
 *
 * 落盘：
 *   <demandDir>/demand/stories.json
 *   <demandDir>/demand/stories-submit-receipt.json
 *
 * Builder-owned 字段（LLM 不要给）：
 *   - schemaVersion / managedBy / writtenAt
 *   - storyHash（receipt 里的 sha256）
 *   - storyIds（有序数组，从 analysis-state.json.stories 派生）
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const RequirementStoryAuthoringDefinition = require('./requirement-story-authoring-definition');

const SCHEMA_VERSION = 'requirement-stories/v1';
const MANAGED_BY = 'requirement_stories_builder';
const RECEIPT_SCHEMA = 'requirement-stories-submit-receipt/v1';
const ALLOWED_EXISTING_ENTRY_FILE_KINDS = new Set(['HtmlPage', 'Action']);
const ALLOWED_DELIVERY_BOUNDARIES = new Set([
    'current_team_ui',
    'external_team_ui',
    'inbound_system_api',
    'outbound_external_api',
    'no_ui'
]);
const CODING_FACT_HANDOFF_ALLOWED_KEYS = new Set([
    'factType',
    'description',
    'confirmedFacts'
]);
const EXISTING_ENTRY_FACT_REQUIRED_NOTE = '既有业务承载入口必须来自用户原文或已有需求事实；如果当前没有明确入口，不猜路径，先省略 existingAdjustment，交由 Design/Coder 在完整骨架和复用证据下定位。';

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.values(value).forEach(deepFreeze);
    return Object.freeze(value);
}

// 单源空白写作骨架：所有 prepare / blocked / repair 返回都引用这一份。
// AGENTS.md 红线 #4「不复制合同」——Skill/reference/AGENTS 不得复制这份示例，
// 骨架故意不是合法 Story：LLM 必须依据当前需求填写，不能直接照抄提交。
const MINIMAL_STORY_EXAMPLE = deepFreeze({
    stories: {
        US1: {
            actor: '',
            userStory: '',
            acceptanceCriteria: {
                happyPath: [{ scenario: '', given: '', when: '', then: '' }]
            }
        }
    }
});

const OPTIONAL_EXISTING_CARRIER_EXAMPLE = Object.freeze({
    whenToUse: '仅当本 Story 必须修改用户已确认的既有页面或 Action 入口时填写。',
    existingAdjustment: {
        entryFiles: [{
            fileKind: 'HtmlPage',
            path: '用户明确提供或已确认的入口文件路径'
        }],
        preserveBehaviors: [{
            businessResult: '本次调整后仍必须保持的既有业务结果',
            regressionScope: '需要回归确认的原流程或页面行为'
        }]
    }
});

const DELIVERY_BOUNDARY_GUIDE = Object.freeze({
    whenToFill: '仅当 Story 的交付跨团队、跨系统或明确无 UI 时填写顶层 deliveryBoundary；普通当前团队管理端页面直接省略。',
    values: Object.freeze({
        current_team_ui: '当前团队负责 UI；仅在需要显式消除方向歧义时填写。',
        external_team_ui: '其它团队负责 UI，本团队只交付其调用的后端能力。',
        inbound_system_api: '其它系统调用本系统，对外 REST 由本系统交付。',
        outbound_external_api: '本系统调用外部系统，不生成本系统对外 REST。',
        no_ui: '纯后台能力、Job 或无交互面的业务结果。'
    }),
    forbidden: '不得用 current_team_ui 给每条普通管理端 Story 机械补默认值；不得用 deliveryBoundary 代替业务验收或外部调用方向判断。'
});

const CODING_FACT_HANDOFF_GUIDE = Object.freeze({
    purpose: '仅承载 Coder 必须消费、且规则/scan/reuseCard 无法稳定推出的额外已确认事实。',
    whenToFill: '确有额外事实时填写 codingFactHandoff[]；没有时省略整个字段。',
    whenAbsent: '没有额外编码事实时直接省略 codingFactHandoff;不要填写空数组、“无”、占位文本或省略理由。缺少该字段本身不会被 Builder/Gate 阻断。',
    sourceAnalysis: '若需求材料已有产品源码分析结论且 Coder 必须消费，只摘录与当前 Story 直接相关的短事实；不要复制整份分析、知识库路径或把结论写成表复用决定。',
    exactShapeRequired: '每项只写 factType、description 和可选 confirmedFacts[]；factId 与来源追踪由 Builder 生成。',
    minimalItemExample: Object.freeze({
        factType: '<事实分类短语>',
        description: '<Coder 必须消费的已确认事实>',
        confirmedFacts: ['<可选:拆成 Coder 可直接消费的事实条目>']
    }),
    fields: Object.freeze({
        factType: '事实分类短语；只用于下游选择相关规则，不代表实现方案。',
        description: '必填，写已确认事实。',
        confirmedFacts: '可选，写需要逐条交给 Coder 的事实。'
    }),
    redLines: Object.freeze([
        '只写已确认事实，不写实现方案。',
        '事实仍不明确时回当前业务卡闭合，不用状态枚举掩盖缺口。'
    ])
});

const STATISTICS_INTENT_GUIDE = Object.freeze({
    purpose: 'Story 级统计口径事实包。凡 Story 的可验收结果是统计、分析、汇总、报表、趋势、排名、分布、成功/失败数量或比例等独立结果，需求阶段必须填写 statisticsIntent；设计阶段只消费它，不临场补统计口径。',
    whenToFill: '命中统计/分析类可验收结果时填写；原始需求没有给出完整指标、维度或筛选口径时，只记录已知业务结果，未决实现口径留给后续 Coder 在完整上下文中确认。',
    fields: Object.freeze({
        title: '统计分析名称。',
        purpose: '统计结果服务谁、解决什么业务查看问题。',
        filters: '可选数组，写筛选条件名称和业务类型；key由Builder生成。',
        dimensions: '可选数组，写分组维度名称；key由Builder生成。',
        metrics: '必填非空数组；每项写指标名称和聚合口径，key由Builder生成。',
        display: '可选对象，只表达 summaryCards/dataGrid/chart/note 等业务展示意图。',
        exportRequired: '可选 boolean，是否有导出诉求。'
    }),
    minimalExample: deepFreeze({
        title: '',
        purpose: '',
        filters: [],
        dimensions: [],
        metrics: [{ label: '', aggregate: '' }],
        display: {},
        exportRequired: false
    })
});

const WORKFLOW_INTENT_GUIDE = Object.freeze({
    purpose: 'Story 级工作流业务事实包。凡 Story 的业务结果依赖审批、提交、退回、转办、待办、流程历史、审批意见或办理流转等工作流引擎能力，需求阶段必须填写 workflowIntent；设计阶段只消费它，不重新识别工作流。',
    whenToFill: '命中完整流程或流程节点办理结果时填写；只描述业务流程名、发起人、节点、操作、流转和用户可验收结果。不要写页面、Action、XML、GUID、vmlId、类名、方法名或路径。',
    fields: Object.freeze({
        processName: '必填，流程中文名。',
        starter: '可选，流程发起角色或触发方。',
        activities: '必填非空数组；每项写name/actor，整个workflowIntent至少有一个真实流程引擎操作；页面查看、填写、上传等能力写入页面合同；动作可用 semantic=save/submit/approve/reject，key由Builder生成。',
        transitions: '必填非空数组；from/to 只能使用 start、end 或同一 workflowIntent.activities[].name 的节点名称。任何不在候选集合中的词都不能直接引用。',
        businessResults: '可选数组，写用户可验收的流程结果，如生成待办、记录意见、可查看流程历史。'
    }),
    transitionReferenceRule: 'transitions 表达流程节点连线，不表达对象完成后的状态或业务结果。业务状态及其结果写进 GWT、不变量或 businessResults。',
    statePlacement: '若某词表示对象所处状态或业务结果，移到 GWT、不变量或 businessResults；若它本意是办理节点，先按角色/动作补进 activities[].name，再在 transitions 引用该精确名称。',
    transitionExample: deepFreeze({
        activities: [
            { name: '申请办理', actor: '<申请角色>', operations: [{ name: '<保存>', semantic: 'save' }, { name: '<提交>', semantic: 'submit' }] },
            { name: '监管审核', actor: '<审核角色>', operations: [{ name: '<审核通过>', semantic: 'approve' }, { name: '<审核不通过>', semantic: 'reject', targetActivity: 'previous', requiresOpinion: true }] }
        ],
        transitions: [
            { from: 'start', to: '申请办理' },
            { from: '申请办理', to: '监管审核' },
            { from: '监管审核', to: 'end', condition: '<通过条件>' },
            { from: '监管审核', to: '申请办理', condition: '<退回条件>' }
        ],
        businessResults: ['<提交后为待审核等业务状态结果>']
    }),
    minimalExample: deepFreeze({
        processName: '',
        starter: '',
        activities: [{ name: '', actor: '', operations: [] }],
        transitions: [{ from: '', to: '' }],
        businessResults: []
    })
});

const WORKFLOW_OPERATION_SEMANTICS = Object.freeze(['save', 'submit', 'approve', 'reject']);

const STORY_AUTHORING_DEFINITION = new RequirementStoryAuthoringDefinition();

const AUTHORING_CONTRACT = deepFreeze({
    schemaVersion: 'requirement-authoring-contract/v3',
    identity: '公开 Story 身份只写 stories.US1 对象键,不要再写 storyId。',
    projectionDefinition: STORY_AUTHORING_DEFINITION.publicContract(),
    conditionalFields: {
        codingFactHandoff: {
            whenToUse: '仅有 Coder 必须消费且受管资产无法稳定推出的已确认事实时填写。',
            defaultAction: 'omit',
            itemShape: {
                factType: '',
                description: '',
                confirmedFacts: []
            }
        },
        statisticsIntent: {
            whenToUse: 'Story交付可独立验收的统计、分析、汇总或报表结果时填写。',
            shape: STATISTICS_INTENT_GUIDE.minimalExample
        },
        workflowIntent: {
            whenToUse: 'Story业务结果依赖审批、流转、待办或流程历史时填写。',
            transitionRule: 'from/to 只连 start、end 或 activities[].name；非候选词若是状态/结果写 businessResults，若是节点先补 activities。',
            shape: WORKFLOW_INTENT_GUIDE.minimalExample
        },
        existingAdjustment: {
            whenToUse: '本Story必须修改用户已确认的既有页面或Action入口时填写。',
            shape: {
                entryFiles: [{ fileKind: '', path: '' }],
                preserveBehaviors: [{ businessResult: '', regressionScope: '' }]
            }
        },
        deliveryBoundary: {
            whenToUse: '仅跨团队、跨系统或明确无UI时填写。',
            allowedValues: Array.from(ALLOWED_DELIVERY_BOUNDARIES)
        }
    },
    step6_5SelfCheck: [
        'Actor完整性：Step 4.5受影响方与Step 2.5 Actor是否都能回到Step 1。',
        '不变量降级：Step 4是否没有混入单页面校验。',
        'ABC决策可追溯：用户决策是否都已消化进受影响Story。'
    ]
});

function _projectAllowedFieldNames(projectionDefinition, fieldPath = []) {
    const node = fieldPath.reduce((current, fieldName) => current.fields[fieldName], projectionDefinition);
    return Object.keys(node.fields);
}

// 首屏只投影当前写作需要的空槽；完整字段投影树仍由同一 Builder 合同用于校验和 repair。
const PREPARE_AUTHORING_CONTRACT = deepFreeze({
    schemaVersion: AUTHORING_CONTRACT.schemaVersion,
    identity: AUTHORING_CONTRACT.identity,
    allowedFieldPaths: {
        story: _projectAllowedFieldNames(AUTHORING_CONTRACT.projectionDefinition),
        acceptanceCriteria: _projectAllowedFieldNames(
            AUTHORING_CONTRACT.projectionDefinition,
            ['acceptanceCriteria']
        ),
        statisticsIntent: _projectAllowedFieldNames(
            AUTHORING_CONTRACT.projectionDefinition,
            ['statisticsIntent']
        ),
        statisticsIntentDisplay: _projectAllowedFieldNames(
            AUTHORING_CONTRACT.projectionDefinition,
            ['statisticsIntent', 'display']
        )
    },
    conditionalFields: AUTHORING_CONTRACT.conditionalFields,
    step6_5SelfCheck: AUTHORING_CONTRACT.step6_5SelfCheck
});

function _buildMinimalCallTemplate(projectPath) {
    const projectLine = projectPath ? JSON.stringify(projectPath) : '"TEMPLATE_FILL_REQUIRED"';
    return [
        'req_stories_submit({',
        `  projectPath: ${projectLine},`,
        '  skillName: "epoint-requirement-analyzer"',
        '})'
    ].join('\n');
}

function _buildFocusedStructureCallTemplate(projectPath) {
    const projectLine = projectPath ? JSON.stringify(projectPath) : '"TEMPLATE_FILL_REQUIRED"';
    return [
        'req_stories_submit({',
        `  projectPath: ${projectLine},`,
        '  skillName: "epoint-requirement-analyzer"',
        '})'
    ].join('\n');
}

function _buildPrepareContextCallTemplate(projectPath) {
    return `req_prepare_context(${JSON.stringify({
        projectPath: projectPath || 'TEMPLATE_FILL_REQUIRED',
        skillName: 'epoint-requirement-analyzer'
    })})`;
}

const ACCEPTANCE_EMPTY_ISSUE_CODES = new Set([
    'REQUIREMENT_STORIES_SUBMIT_ACCEPTANCE_HAPPYPATH_EMPTY'
]);

function _hasIssueCode(issues = [], predicate = () => false) {
    return (Array.isArray(issues) ? issues : []).some(issue => predicate(String(issue && issue.code || '')));
}

function _profileStoryIssues(issues = []) {
    const hasAcceptanceEmpty = _hasIssueCode(issues, code => ACCEPTANCE_EMPTY_ISSUE_CODES.has(code));
    const hasExistingCarrier = _hasIssueCode(issues, code =>
        code.indexOf('REQUIREMENT_STORIES_SUBMIT_EXISTING_ADJUSTMENT') === 0);
    const hasCodingFact = _hasIssueCode(issues, code =>
        code.indexOf('REQUIREMENT_STORIES_SUBMIT_CODING_FACT') === 0);
    const hasStatisticsIntent = _hasIssueCode(issues, code =>
        code.indexOf('REQUIREMENT_STORIES_SUBMIT_STATISTICS_INTENT') === 0);
    const hasWorkflowIntent = _hasIssueCode(issues, code =>
        code.indexOf('REQUIREMENT_STORIES_SUBMIT_WORKFLOW_INTENT') === 0);
    const hasDeliveryBoundary = _hasIssueCode(issues, code =>
        code.indexOf('REQUIREMENT_STORIES_SUBMIT_DELIVERY_BOUNDARY') === 0);
    const hasConfirmedAmbiguityOrAudit = _hasIssueCode(issues, code =>
        code === 'REQUIREMENT_STORIES_IMPLEMENTATION_AUDIT_LEAKED_TO_BUSINESS_FACTS');
    return {
        hasAcceptanceEmpty,
        hasExistingCarrier,
        hasCodingFact,
        hasStatisticsIntent,
        hasWorkflowIntent,
        hasDeliveryBoundary,
        hasConfirmedAmbiguityOrAudit,
        hasSemanticRepair: hasExistingCarrier
            || hasCodingFact
            || hasStatisticsIntent
            || hasWorkflowIntent
            || hasDeliveryBoundary
            || hasConfirmedAmbiguityOrAudit
    };
}

function _buildIssuesNextActionCard(projectPath, issues = [], storyCount = 0, options = {}) {
    const retryPrepare = options.retryTool === 'req_prepare_context';
    const retryTool = retryPrepare ? 'req_prepare_context' : 'req_stories_submit';
    const repairCount = issues.filter(issue => typeof issue.repair === 'string' && issue.repair.trim()).length;
    const repairInstruction = repairCount === issues.length
        ? '先汇总全部 issues[]，按 storyId/field 分组形成一次性修复清单；每条 issue 都给了该字段的具体填法。'
        : `先汇总全部 issues[]，按 storyId/field 分组形成一次性修复清单；带 repair 文案的 ${repairCount}/${issues.length} 条按 issues[].repair 修，未带 repair 的字段按 nextActionCard.minimalExample 的同名字段对照修。`;
    const profile = _profileStoryIssues(issues);
    const instructionParts = [
        '先按 analysis-state.json 的 currentStep/stepStatus 完成 Step 5.5 Story业务补全和 Step 6/6.5 自检，禁止通过字段修复直接跳过业务步骤。',
        repairInstruction,
        `只修 analysis-state.json.stories 中对应 Story 业务事实;必须一次性修完全部 issues 以及同 Story 同类缺项后,再按 callTemplate 重调 ${retryTool};禁止修一条就重调。`,
        '结构要求:acceptanceCriteria 必须是 object且happyPath至少1条;exception/boundary/invariants 只有真实业务事实时才写,出现时必须是数组;GWT 必须含 scenario/given/when/then。'
    ];

    if (profile.hasExistingCarrier) {
        instructionParts.push(`涉及 existingAdjustment 时只补用户已确认的 HtmlPage/Action 入口和必须保持的原业务结果。${EXISTING_ENTRY_FACT_REQUIRED_NOTE}`);
    }
    if (profile.hasCodingFact) {
        instructionParts.push('涉及 codingFactHandoff 时每项只写 factType、description 和可选 confirmedFacts[]；没有额外事实时删除整个字段。');
    }
    if (profile.hasStatisticsIntent) {
        instructionParts.push('涉及 statisticsIntent 时只补统计标题、目的、筛选、维度、指标和展示意图；稳定key和来源账务由系统生成。');
    }
    if (profile.hasWorkflowIntent) {
        instructionParts.push('涉及 workflowIntent 时只补流程名、发起人、节点名称/角色、业务操作、流转和可验收结果；transitions.from/to 只能填 start、end 或同 Story activities[].name。非候选引用若表达状态/结果，移到 GWT、不变量或 businessResults；若本意是节点，先补 activities 后再引用精确节点名；节点key由系统生成。');
    }
    if (profile.hasDeliveryBoundary) {
        instructionParts.push('涉及 deliveryBoundary 的 issue，只按跨团队/跨系统方向修当前 Story；普通当前团队管理端 UI 删除该字段即可，不要全量补默认值。');
    }
    if (profile.hasConfirmedAmbiguityOrAudit) {
        instructionParts.push('涉及审计槽污染时，rawUserReply / implementationPreferenceAuditOnly 只留在过程账本；Story只写GWT和不变量等净化业务事实。');
    }

    const card = {
        title: profile.hasSemanticRepair
            ? `修复 ${issues.length} 条 Story 业务/字段问题后重调 ${retryTool}`
            : `修复 ${issues.length} 条 Story 结构问题后重调 ${retryTool}`,
        stopAfter: false,
        instruction: instructionParts.join(' '),
        issueRepairBatchPolicy: {
            mustReviewAllIssues: true,
            repairTarget: 'analysis-state.json.stories',
            rerunOnlyAfterAllIssuesFixed: true,
            forbidden: ['rerun_after_single_issue_fix', 'write_stories_json_directly']
        },
        minimalExample: MINIMAL_STORY_EXAMPLE,
        authoringContract: AUTHORING_CONTRACT,
        callTemplate: retryPrepare
            ? _buildPrepareContextCallTemplate(projectPath)
            : (profile.hasSemanticRepair
                ? _buildMinimalCallTemplate(projectPath)
                : _buildFocusedStructureCallTemplate(projectPath))
    };
    if (profile.hasExistingCarrier) {
        card.optionalExistingCarrierExample = OPTIONAL_EXISTING_CARRIER_EXAMPLE;
    }
    if (profile.hasCodingFact) {
        card.codingFactHandoffGuide = CODING_FACT_HANDOFF_GUIDE;
    }
    if (profile.hasStatisticsIntent) {
        card.statisticsIntentGuide = STATISTICS_INTENT_GUIDE;
    }
    if (profile.hasWorkflowIntent) {
        card.workflowIntentGuide = WORKFLOW_INTENT_GUIDE;
    }
    if (profile.hasDeliveryBoundary) {
        card.deliveryBoundaryGuide = DELIVERY_BOUNDARY_GUIDE;
    }
    return card;
}

class RequirementStoriesBuilderService {
    constructor(options = {}) {
        this.options = options;
        this.fs = options.fs || fs;
        this.authoringDefinition = options.authoringDefinition || STORY_AUTHORING_DEFINITION;
    }

    ensureAnalysisStateSkeleton(options = {}) {
        const analysisStatePath = String(options.analysisStatePath || '').trim();
        if (!analysisStatePath) {
            return { ok: false, errorCode: 'REQUIREMENT_ANALYSIS_STATE_PATH_MISSING' };
        }
        if (this.fs.existsSync(analysisStatePath)) {
            return { ok: true, created: false, path: analysisStatePath };
        }
        const skeleton = {
            schemaVersion: 'analysis-state/v1',
            demandName: String(options.demandName || '').trim(),
            status: 'in_progress',
            currentStep: 'step1',
            stepStatus: {},
            stories: {}
        };
        const tempPath = `${analysisStatePath}.${process.pid}.${Date.now()}.tmp`;
        try {
            this.fs.mkdirSync(path.dirname(analysisStatePath), { recursive: true });
            this.fs.writeFileSync(tempPath, `${JSON.stringify(skeleton, null, 2)}\n`, 'utf-8');
            this.fs.renameSync(tempPath, analysisStatePath);
            return { ok: true, created: true, path: analysisStatePath, skeleton };
        } catch (error) {
            try {
                if (this.fs.existsSync(tempPath)) this.fs.unlinkSync(tempPath);
            } catch (_) {}
            return {
                ok: false,
                errorCode: 'REQUIREMENT_ANALYSIS_STATE_SKELETON_WRITE_FAILED',
                message: `analysis-state.json 空白骨架写入失败：${error.message}`,
                path: analysisStatePath
            };
        }
    }

    prepareRevision({ analysisStatePath, feedback, affectedStoryIds }) {
        try {
            const state = JSON.parse(this.fs.readFileSync(analysisStatePath, 'utf8'));
            const storyIds = affectedStoryIds || Object.keys(state.stories || {});
            const unknown = storyIds.filter(id => !state.stories || !state.stories[id]);
            if (unknown.length) return { ok: false, status: 'repair_required', stopAfter: false,
                errorCode: 'REQUIREMENT_REVISION_STORY_UNKNOWN', unknownStoryIds: unknown,
                allowedStoryIds: Object.keys(state.stories || {}) };
            const requestHash = crypto.createHash('sha256').update(JSON.stringify([storyIds, feedback])).digest('hex');
            if (state.revision?.requestHash === requestHash) return { ok: true, revision: state.revision, idempotentReplay: true };
            state.revision = { requestHash, feedback, storyIds };
            state.status = 'in_progress';
            state.currentStep = 'step2';
            const tempPath = `${analysisStatePath}.revision.tmp`;
            this.fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
            this.fs.renameSync(tempPath, analysisStatePath);
            return { ok: true, revision: state.revision };
        } catch (error) {
            return { ok: false, status: 'repair_required', stopAfter: false,
                errorCode: 'REQUIREMENT_REVISION_PREPARE_FAILED', message: `需求修订准备失败：${error.message}`,
                allowedNextActions: ['rerun_req_prepare_context_with_revision'] };
        }
    }

    validateAnalysisStateRoot(args = {}) {
        const projectPath = String(args.projectPath || '').trim();
        const paths = args.paths || {};
        const analysisStatePath = String(paths.analysisStatePath || '').trim();
        let analysisState = null;
        if (analysisStatePath && fs.existsSync(analysisStatePath)) {
            try {
                analysisState = JSON.parse(fs.readFileSync(analysisStatePath, 'utf-8'));
            } catch (error) {
                return this._blocked('REQUIREMENT_STORIES_SUBMIT_ANALYSIS_STATE_JSON_INVALID',
                    `analysis-state.json 不是合法 JSON：${error.message}`,
                    { projectPath, args, analysisStatePath, hint: 'analysis_state_json_invalid' });
            }
        }
        if (Object.prototype.hasOwnProperty.call(analysisState || {}, 'codingFactHandoff')) {
            return this._blocked('REQUIREMENT_STORIES_SUBMIT_ROOT_CODING_FACT_HANDOFF_FORBIDDEN',
                'codingFactHandoff 只能写在受影响的 stories.USx 内；禁止在 analysis-state 根级维护第二套事实分发入口。',
                { projectPath, args, analysisStatePath, hint: 'root_coding_fact_handoff_forbidden' });
        }
        const authoringIssues = this._validateAuthoringStories(analysisState);
        const inputStories = this._extractStoriesFromAnalysisState(analysisState);
        if ((!Array.isArray(inputStories) || inputStories.length === 0) && authoringIssues.length === 0) {
            return this._blocked('REQUIREMENT_STORIES_SUBMIT_ANALYSIS_STATE_STORIES_EMPTY',
                'analysis-state.json.stories 不能为空：请在 Builder 已创建的 stories 对象内按 stories.US1 / stories.US2 写入 Story，不要自创 step2_stories 或独立验收分区。',
                { projectPath, args, analysisStatePath, hint: 'analysis_state_stories_empty' });
        }
        return { ok: true, analysisState, inputStories, authoringIssues };
    }

    validateAnalysisStateAuthoringForPrepare(args = {}) {
        const projectPath = String(args.projectPath || '').trim();
        const paths = args.paths || {};
        const analysisStatePath = String(paths.analysisStatePath || '').trim();
        if (!analysisStatePath || !fs.existsSync(analysisStatePath)) {
            return { ok: true, storyCount: 0, issues: [] };
        }
        let analysisState;
        try {
            analysisState = JSON.parse(fs.readFileSync(analysisStatePath, 'utf-8'));
        } catch (error) {
            return {
                ok: false,
                status: 'blocked',
                actionMode: 'repair_requirement_story_authoring',
                source: 'requirement_stories_builder',
                errorCode: 'REQUIREMENT_STORIES_PREPARE_ANALYSIS_STATE_JSON_INVALID',
                message: `analysis-state.json 不是合法 JSON：${error.message}`,
                issues: [{
                    code: 'REQUIREMENT_STORIES_PREPARE_ANALYSIS_STATE_JSON_INVALID',
                    field: 'analysis-state.json',
                    message: '先恢复合法 JSON，再继续需求分析。'
                }],
                nextActionCard: {
                    title: '修复 analysis-state.json 后重调 req_prepare_context',
                    stopAfter: false,
                    instruction: '只修复 JSON 语法，不改业务答案；修复后按 callTemplate 重调 req_prepare_context。',
                    callTemplate: _buildPrepareContextCallTemplate(projectPath)
                },
                allowedNextActions: ['repair_analysis_state_json_then_rerun_req_prepare_context'],
                forbiddenActions: ['continue_requirement_analysis_with_invalid_json']
            };
        }
        const issues = this._validateAuthoringStories(analysisState);
        if (issues.length === 0) {
            return {
                ok: true,
                storyCount: this._extractStoriesFromAnalysisState(analysisState).length,
                issues: []
            };
        }
        const storyCount = this._extractStoriesFromAnalysisState(analysisState).length;
        return {
            ok: false,
            status: 'blocked',
            actionMode: 'repair_requirement_story_authoring',
            source: 'requirement_stories_builder',
            errorCode: 'REQUIREMENT_STORIES_PREPARE_AUTHORING_INVALID',
            message: 'analysis-state.json.stories 含作者合同外字段；必须先一次性修复，不能继续下一张业务卡。',
            issues,
            nextActionCard: _buildIssuesNextActionCard(projectPath, issues, storyCount, {
                retryTool: 'req_prepare_context'
            }),
            allowedNextActions: ['repair_all_authoring_issues_then_rerun_req_prepare_context'],
            forbiddenActions: [
                'continue_to_next_ambiguity_card_before_authoring_repair',
                'call_req_stories_submit_before_prepare_passes',
                'write_stories_json_directly'
            ]
        };
    }

    /**
     * 主入口：提交一批 User Story，Builder 落盘 stories.json + receipt。
     *
     * @param {object} args { projectPath, paths: { storiesPath, storiesReceiptPath, analysisStatePath }, stories?: [...] }
     * @returns { ok, status, source, storyCount?, storyIds?, storyHash?, receipt?, errorCode?, message?, issues? }
     */
    submit(args = {}) {
        const projectPath = String(args.projectPath || '').trim();
        if (!projectPath) {
            return this._blocked('REQUIREMENT_STORIES_SUBMIT_PROJECT_PATH_MISSING',
                '缺少 projectPath，无法提交 stories。', { projectPath, args });
        }

        const paths = args.paths || {};
        const storiesPath = String(paths.storiesPath || '').trim();
        const receiptPath = String(paths.storiesReceiptPath || '').trim();
        const analysisStatePath = String(paths.analysisStatePath || '').trim();
        if (!storiesPath || !receiptPath) {
            return this._blocked('REQUIREMENT_STORIES_SUBMIT_PATHS_MISSING',
                '缺少 storiesPath / storiesReceiptPath（应由 req_prepare_context 派生）。',
                { projectPath, args });
        }

        const scanCatalog = this._buildExistingEntryScanCatalog(projectPath);
        if (Object.prototype.hasOwnProperty.call(args, 'stories')) {
            return this._blocked('REQUIREMENT_STORIES_SUBMIT_STORIES_ARG_FORBIDDEN',
                'req_stories_submit 不接收 stories 入参；请先修 analysis-state.json.stories，再用 projectPath + skillName 重调本工具。',
                { projectPath, args, hint: 'stories_arg_forbidden' });
        }
        const rootValidation = this.validateAnalysisStateRoot({ projectPath, paths });
        if (!rootValidation.ok) return rootValidation;
        const analysisState = rootValidation.analysisState;
        const inputStories = rootValidation.inputStories;
        const storySourceDigest = this._buildStorySourceDigest(analysisState, inputStories);
        const storiesWithBuilderFacts = inputStories;

        // 1) 校验：每个 story 必填字段
        const issues = Array.isArray(rootValidation.authoringIssues)
            ? rootValidation.authoringIssues.slice()
            : [];
        const seenIds = new Set();
        storiesWithBuilderFacts.forEach((story, idx) => {
            const storyId = String(story && story.storyId || '').trim().toUpperCase();
            if (!storyId) {
                issues.push({
                    code: 'REQUIREMENT_STORIES_SUBMIT_STORY_ID_MISSING',
                    field: `stories[${idx}].storyId`,
                    message: `stories[${idx}] 缺少 storyId（必须形如 US1/US2/...）。`
                });
                return;
            }
            if (!/^US\d+$/.test(storyId)) {
                issues.push({
                    code: 'REQUIREMENT_STORIES_SUBMIT_STORY_ID_FORMAT_INVALID',
                    field: `stories[${idx}].storyId`,
                    storyId,
                    message: `stories[${idx}].storyId="${storyId}" 必须形如 US1/US2/...（大写 US + 数字）。`
                });
            }
            if (seenIds.has(storyId)) {
                issues.push({
                    code: 'REQUIREMENT_STORIES_SUBMIT_STORY_ID_DUPLICATED',
                    field: `stories[${idx}].storyId`,
                    storyId,
                    message: `stories[${idx}].storyId=${storyId} 重复；每个 storyId 只能出现一次。`
                });
            }
            seenIds.add(storyId);

            ['actor', 'userStory'].forEach(field => {
                if (!String(story && story[field] || '').trim()) {
                    issues.push({
                        code: 'REQUIREMENT_STORIES_SUBMIT_STORY_FIELD_MISSING',
                        field: `stories[${idx}].${field}`,
                        storyId,
                        message: `stories[${idx}].${field} 必填。`,
                        repair: field === 'actor'
                            ? '业务角色名,纯中文 2-8 字,例如「业务部门」「办事窗口」「申报人」;直接从用户原话里识别谁在用,不要写「用户」这种泛词。'
                            : '一句话用户故事,格式「作为 [Actor],我希望 [动作],以便 [价值]」,纯业务语言,不要写技术实现。例如「作为业务部门,我希望维护场所信息,以便业务办理时调到最新场所」。'
                    });
                }
            });

            const ac = story && story.acceptanceCriteria;
            if (!ac || typeof ac !== 'object' || Array.isArray(ac)) {
                issues.push({
                    code: 'REQUIREMENT_STORIES_SUBMIT_ACCEPTANCE_NOT_OBJECT',
                    field: `stories[${idx}].acceptanceCriteria`,
                    storyId,
                    message: `stories[${idx}].acceptanceCriteria 必须是对象（含 happyPath/exception/boundary）。`,
                    repair: 'acceptanceCriteria 是 object,不是 array。形态:{ happyPath: [...], exception: [...], boundary: [] }。happyPath/exception 各至少 1 条 GWT;boundary 可空,若填写则每条 GWT 是 { scenario, given, when, then } 四字段。按 nextActionCard.minimalExample 抄结构。'
                });
            } else {
                ['happyPath', 'exception', 'boundary'].forEach(group => {
                    if (group !== 'happyPath' && typeof ac[group] === 'undefined') return;
                    if (!Array.isArray(ac[group])) {
                        issues.push({
                            code: 'REQUIREMENT_STORIES_SUBMIT_ACCEPTANCE_GROUP_INVALID',
                            field: `stories[${idx}].acceptanceCriteria.${group}`,
                            storyId,
                            message: `stories[${idx}].acceptanceCriteria.${group} 必须是数组。`,
                            repair: `${group} 是 GWT 数组(不是对象、不是字符串),每项形态 { scenario, given, when, then }。happyPath 至少1条;exception/boundary 没有真实事实时可省略。`
                        });
                    }
                });
                if (Array.isArray(ac.happyPath) && ac.happyPath.length === 0) {
                    issues.push({
                        code: 'REQUIREMENT_STORIES_SUBMIT_ACCEPTANCE_HAPPYPATH_EMPTY',
                        field: `stories[${idx}].acceptanceCriteria.happyPath`,
                        storyId,
                        message: `stories[${idx}].acceptanceCriteria.happyPath 至少 1 条 GWT（业务正常走通的场景）。`,
                        repair: '主路径 - 用户、数据、操作都符合预期时系统给出预期结果。例：given 已登录用户进入新增页面 / when 填齐必填字段并保存 / then 系统持久化并提示成功。'
                    });
                }
                ['happyPath', 'exception', 'boundary'].forEach(group => {
                    if (!Array.isArray(ac[group])) return;
                    ac[group].forEach((gwt, gIdx) => {
                        if (!gwt || typeof gwt !== 'object' || Array.isArray(gwt)) {
                            issues.push({
                                code: 'REQUIREMENT_STORIES_SUBMIT_ACCEPTANCE_GWT_NOT_OBJECT',
                                field: `stories[${idx}].acceptanceCriteria.${group}[${gIdx}]`,
                                storyId,
                                message: `stories[${idx}].acceptanceCriteria.${group}[${gIdx}] 必须是 object,含 scenario/given/when/then。`,
                                repair: '每条 GWT 必须是对象,四字段缺一不可:scenario(场景名,中文短语)、given(前置条件)、when(用户/系统动作)、then(系统应有响应)。不要写成字符串,也不要嵌套数组。按 nextActionCard.minimalExample 抄一条结构。'
                            });
                            return;
                        }
                        ['scenario', 'given', 'when', 'then'].forEach(field => {
                            if (!String(gwt[field] || '').trim()) {
                                const repairByField = {
                                    scenario: '场景名,一行中文短语概括本 GWT 在测什么,例如「正常新增」「名称重复」「名称达 50 字上限」。',
                                    given: '前置条件,描述测试开始前系统/数据处于什么状态,例如「业务部门已登录新增页面」「系统中已存在同名场所」。',
                                    when: '触发动作,描述用户或系统执行什么操作,例如「填齐必填字段并保存」「业务部门提交同名新增」。',
                                    then: '预期结果,描述系统应当如何响应(成功提示、拒绝原因、校验错误等),例如「系统持久化并提示新增成功」「系统拒绝并提示场所名称已存在」。'
                                };
                                issues.push({
                                    code: 'REQUIREMENT_STORIES_SUBMIT_ACCEPTANCE_GWT_FIELD_MISSING',
                                    field: `stories[${idx}].acceptanceCriteria.${group}[${gIdx}].${field}`,
                                    storyId,
                                    message: `stories[${idx}].acceptanceCriteria.${group}[${gIdx}].${field} 必填。`,
                                    repair: repairByField[field]
                                });
                            }
                        });
                    });
                });
            }

            if (story && Object.prototype.hasOwnProperty.call(story, 'invariants') && !Array.isArray(story.invariants)) {
                issues.push({
                    code: 'REQUIREMENT_STORIES_SUBMIT_INVARIANTS_NOT_ARRAY',
                    field: `stories[${idx}].invariants`,
                    storyId,
                    message: `stories[${idx}].invariants 必须是数组（可省略，默认为空数组）。`,
                    repair: 'invariants 必须是字符串数组;没有不变量时填 [] 或省略字段,不要写成字符串或对象。'
                });
            }

            const entryFiles = this._rawExistingEntryFiles(story);
            if (story && Object.prototype.hasOwnProperty.call(story, 'existingAdjustment') && entryFiles.length === 0) {
                issues.push({
                    code: 'REQUIREMENT_STORIES_SUBMIT_EXISTING_ADJUSTMENT_ENTRY_FILES_REQUIRED',
                    field: `stories[${idx}].existingAdjustment.entryFiles`,
                    storyId,
                    message: 'existingAdjustment 出现时必须提供至少1个已确认入口文件，fileKind只能是HtmlPage或Action。',
                    repair: `${EXISTING_ENTRY_FACT_REQUIRED_NOTE} 如果本Story不修改既有入口，删除existingAdjustment。`
                });
            }
            entryFiles.forEach((entry, entryIdx) => {
                const fileKind = String(entry && entry.fileKind || '').trim();
                const entryPath = String(entry && (entry.path || entry.resolvedPath || entry.filePath) || '').trim();
                if (!ALLOWED_EXISTING_ENTRY_FILE_KINDS.has(fileKind)) {
                    issues.push({
                        code: 'REQUIREMENT_STORIES_SUBMIT_EXISTING_ADJUSTMENT_ENTRY_FILE_KIND_INVALID',
                        field: `stories[${idx}].existingAdjustment.entryFiles[${entryIdx}].fileKind`,
                        storyId,
                        message: `历史功能调整入口文件只允许 HtmlPage / Action，不能提交 ${fileKind || '(empty)'}。`
                    });
                }
                if (!entryPath) {
                    issues.push({
                        code: 'REQUIREMENT_STORIES_SUBMIT_EXISTING_ADJUSTMENT_ENTRY_FILE_PATH_MISSING',
                        field: `stories[${idx}].existingAdjustment.entryFiles[${entryIdx}].path`,
                        storyId,
                        message: '历史功能调整入口文件 path 必填；只需要 HtmlPage 或 Action 任意入口路径。'
                    });
                    return;
                }
                if (!this._resolveEntryPathWithinProject(projectPath, entryPath)) {
                    issues.push({
                        code: 'REQUIREMENT_STORIES_SUBMIT_EXISTING_ADJUSTMENT_ENTRY_FILE_OUTSIDE_PROJECT',
                        field: `stories[${idx}].existingAdjustment.entryFiles[${entryIdx}].path`,
                        storyId,
                        message: '历史功能调整入口文件必须位于当前 projectPath 内，禁止绝对路径越界或相对路径 .. 逃逸。'
                    });
                    return;
                }
                const resolution = this._resolveExistingEntryReference(entry, projectPath, scanCatalog);
                if (!resolution.ok) {
                    issues.push({
                        code: resolution.code,
                        field: `stories[${idx}].existingAdjustment.entryFiles[${entryIdx}].path`,
                        storyId,
                        message: resolution.message,
                        repair: resolution.repair
                    });
                }
            });

            const rawPreserveBehaviors = this._rawExistingPreserveBehaviorsValue(story);
            if (typeof rawPreserveBehaviors !== 'undefined') {
                if (!Array.isArray(rawPreserveBehaviors)) {
                    issues.push({
                        code: 'REQUIREMENT_STORIES_SUBMIT_EXISTING_ADJUSTMENT_PRESERVE_BEHAVIORS_NOT_ARRAY',
                        field: `stories[${idx}].existingAdjustment.preserveBehaviors`,
                        storyId,
                        message: '既有业务结果保留说明 preserveBehaviors 必须是数组；每条写一个业务结果和回归范围。'
                    });
                } else if (rawPreserveBehaviors.length === 0) {
                    issues.push({
                        code: 'REQUIREMENT_STORIES_SUBMIT_EXISTING_ADJUSTMENT_PRESERVE_BEHAVIORS_EMPTY',
                        field: `stories[${idx}].existingAdjustment.preserveBehaviors`,
                        storyId,
                        message: 'preserveBehaviors 已出现时至少写 1 条既有业务结果；如果本 Story 不涉及历史功能保留，可删除该字段。'
                    });
                } else {
                    rawPreserveBehaviors.forEach((item, preserveIdx) => {
                        if (!item || typeof item !== 'object' || Array.isArray(item)) {
                            issues.push({
                                code: 'REQUIREMENT_STORIES_SUBMIT_EXISTING_ADJUSTMENT_PRESERVE_BEHAVIOR_NOT_OBJECT',
                                field: `stories[${idx}].existingAdjustment.preserveBehaviors[${preserveIdx}]`,
                                storyId,
                                message: '每条 preserveBehaviors 必须是 object，至少包含 businessResult，可选 regressionScope。'
                            });
                            return;
                        }
                        const businessResult = String(item.businessResult || '').trim();
                        if (!businessResult) {
                            issues.push({
                                code: 'REQUIREMENT_STORIES_SUBMIT_EXISTING_ADJUSTMENT_PRESERVE_BEHAVIOR_RESULT_MISSING',
                                field: `stories[${idx}].existingAdjustment.preserveBehaviors[${preserveIdx}].businessResult`,
                                storyId,
                                message: 'businessResult 必填，请用业务语言说明本次调整后仍必须保持的既有业务结果。'
                            });
                        }
                        if (Object.prototype.hasOwnProperty.call(item, 'regressionScope')
                            && !String(item.regressionScope || '').trim()) {
                            issues.push({
                                code: 'REQUIREMENT_STORIES_SUBMIT_EXISTING_ADJUSTMENT_PRESERVE_BEHAVIOR_REGRESSION_SCOPE_EMPTY',
                                field: `stories[${idx}].existingAdjustment.preserveBehaviors[${preserveIdx}].regressionScope`,
                                storyId,
                                message: 'regressionScope 出现时必须写清回归范围；如果暂时没有回归范围，可删除该字段。'
                            });
                        }
                    });
                }
            }
            this._validateDeliveryBoundary(story, idx, storyId, issues);
            this._validateStatisticsIntent(story, idx, storyId, issues);
            this._validateWorkflowIntent(story, idx, storyId, issues);
            this._validateCodingFactHandoff(story, idx, storyId, issues);
        });
        if (analysisState) {
            issues.push(...this._collectImplementationAuditLeakIssues(analysisState, storiesWithBuilderFacts));
        }

        if (issues.length > 0) {
            const storyCount = inputStories.length;
            return {
                ok: false,
                status: 'repair_required',
                actionMode: 'repair_requirement_stories_input',
                source: 'requirement_stories_builder',
                errorCode: 'REQUIREMENT_STORIES_SUBMIT_INPUT_INVALID',
                message: 'analysis-state.json.stories 不合法,请按 issues 回到 analysis-state 修复后重试。',
                issues,
                nextActionCard: _buildIssuesNextActionCard(projectPath, issues, storyCount),
                machineRecoverable: true,
                stopLockRequired: false,
                allowedNextActions: ['rerun_req_stories_submit_after_repair'],
                forbiddenActions: ['write_stories_json_directly', 'fs_write_demand_md_user_story_section_directly']
            };
        }

        // 2) 归一化 + 落盘
        const normalized = storiesWithBuilderFacts
            .map(story => this._normalizeStory(story, projectPath, scanCatalog));
        const storyIds = normalized.map(s => s.storyId);
        const writtenAt = new Date().toISOString();
        const storiesDoc = {
            schemaVersion: SCHEMA_VERSION,
            managedBy: MANAGED_BY,
            stories: normalized,
            storyIds,
            writtenAt
        };

        let storiesJsonText;
        try {
            storiesJsonText = JSON.stringify(storiesDoc, null, 2);
            fs.mkdirSync(path.dirname(storiesPath), { recursive: true });
            fs.writeFileSync(storiesPath, storiesJsonText, 'utf-8');
        } catch (error) {
            return this._blocked('REQUIREMENT_STORIES_SUBMIT_WRITE_FAILED',
                `stories.json 落盘失败：${error.message}`);
        }

        const storyHash = `sha256:${crypto.createHash('sha256').update(storiesJsonText, 'utf-8').digest('hex')}`;

        // 3) 写 receipt
        const receipt = {
            schemaVersion: RECEIPT_SCHEMA,
            status: 'submitted',
            ok: true,
            storyHash,
            storySourceDigest,
            storyCount: storyIds.length,
            storyIds,
            submittedAt: writtenAt
        };
        try {
            fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), 'utf-8');
        } catch (error) {
            return this._blocked('REQUIREMENT_STORIES_SUBMIT_RECEIPT_WRITE_FAILED',
                `stories-submit-receipt.json 写入失败：${error.message}`);
        }

        // AGENTS.md "确定事实不进 LLM 视野" 红线：storyIds 是从 stories.json 派生的确定事实，
        // 不再合回 analysis-state.json 维护第二份。下游消费 storyIds 直接读 stories.json。
        // 历史版本曾在此合回 storyIds，但若 LLM 后续整文件覆盖 analysis-state.json（例如标 done 时
        // 用 IDE Write），复制品会被冲掉，触发 STORY_ANCHORS_EMPTY 假阳性 blocked。

        return {
            ok: true,
            status: 'submitted',
            actionMode: 'continue_requirement_analysis',
            source: 'requirement_stories_builder',
            storySource: 'analysis-state',
            storyCount: storyIds.length,
            storyIds,
            storyHash,
            receipt: { written: true, path: receiptPath },
            written: { storiesPath, receiptPath },
            allowedNextActions: ['continue_to_rule_pool', 'rerun_req_stories_submit_to_replace_all_stories']
        };
    }

    /**
     * analysis-state.json 是 Story 业务事实源，stories.json 是 Builder 投影。
     * 若已经提交过 stories.json，但 analysis-state 后续又被补充了 stories 字段，
     * 消费前自动重投影，避免下游继续读取旧机器合同。
     */
    refreshFromAnalysisStateIfStale(options = {}) {
        const projectPath = String(options.projectPath || '').trim();
        const storiesPath = String(options.storiesPath || '').trim();
        const receiptPath = String(options.storiesReceiptPath || '').trim();
        const analysisStatePath = String(options.analysisStatePath || '').trim();
        if (!projectPath || !storiesPath || !receiptPath || !analysisStatePath) {
            return { ok: true, refreshed: false, skipped: 'paths_incomplete' };
        }
        if (!fs.existsSync(storiesPath) || !fs.existsSync(receiptPath) || !fs.existsSync(analysisStatePath)) {
            return { ok: true, refreshed: false, skipped: 'artifact_missing' };
        }
        let receipt = null;
        try {
            receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf-8'));
        } catch (error) {
            return {
                ok: false,
                code: 'REQUIREMENT_STORIES_SUBMIT_RECEIPT_INVALID',
                message: `Builder 提交凭证无法解析：${receiptPath}；${error.message}`
            };
        }
        const receiptSourceDigest = String(receipt && receipt.storySourceDigest || '').trim();
        if (!receiptSourceDigest) {
            return {
                ok: false,
                code: 'REQUIREMENT_STORIES_SOURCE_DIGEST_MISSING',
                message: 'stories-submit-receipt.json 缺少 storySourceDigest；请重新调用 req_stories_submit，由 Builder 基于 analysis-state.json.stories 重新投影 stories.json。'
            };
        }
        let analysisState = null;
        try {
            analysisState = JSON.parse(fs.readFileSync(analysisStatePath, 'utf-8'));
        } catch (error) {
            return {
                ok: false,
                code: 'REQUIREMENT_STORIES_STALE_REFRESH_ANALYSIS_STATE_INVALID',
                message: `analysis-state.json 已晚于 stories.json，但无法解析，不能刷新 Story 投影：${error.message}`
            };
        }
        const inputStories = this._extractStoriesFromAnalysisState(analysisState);
        if (!Array.isArray(inputStories) || inputStories.length === 0) {
            return { ok: true, refreshed: false, skipped: 'analysis_state_has_no_story_source' };
        }
        const currentSourceDigest = this._buildStorySourceDigest(analysisState, inputStories);
        if (currentSourceDigest === receiptSourceDigest) {
            return {
                ok: true,
                refreshed: false,
                skipped: 'projection_current',
                storySourceDigest: currentSourceDigest
            };
        }
        const submitResult = this.submit({
            projectPath,
            paths: { storiesPath, storiesReceiptPath: receiptPath, analysisStatePath }
        });
        if (!submitResult || submitResult.ok !== true) {
            return {
                ok: false,
                code: submitResult && submitResult.errorCode
                    ? submitResult.errorCode
                    : 'REQUIREMENT_STORIES_STALE_REFRESH_FAILED',
                message: submitResult && submitResult.message
                    ? submitResult.message
                    : 'analysis-state.json 已晚于 stories.json，但 Builder 重新投影失败。',
                issues: submitResult && Array.isArray(submitResult.issues) ? submitResult.issues : [],
                nextActionCard: submitResult && submitResult.nextActionCard ? submitResult.nextActionCard : null
            };
        }
        return {
            ok: true,
            refreshed: true,
            storyHash: submitResult.storyHash,
            storyIds: submitResult.storyIds || []
        };
    }

    /**
     * 校验 stories.json 是否由 Builder 合法落盘（供 req_finalize_artifacts 调用）。
     * 与 RequirementRulePoolBuilderService.validateSubmitReceipt 同款。
     */
    validateSubmitReceipt(options = {}) {
        const refreshResult = this.refreshFromAnalysisStateIfStale(options);
        if (refreshResult && refreshResult.ok === false) {
            return refreshResult;
        }
        const storiesPath = String(options.storiesPath || '').trim();
        const receiptPath = String(options.storiesReceiptPath || '').trim();
        const analysisStatePath = String(options.analysisStatePath || '').trim();
        if (!storiesPath || !fs.existsSync(storiesPath)) {
            return { ok: false, code: 'REQUIREMENT_STORIES_FILE_MISSING',
                message: `缺少 stories.json：${storiesPath}` };
        }
        let stories = null;
        try {
            stories = JSON.parse(fs.readFileSync(storiesPath, 'utf-8'));
        } catch (error) {
            return { ok: false, code: 'REQUIREMENT_STORIES_INVALID_JSON',
                message: `stories.json 解析失败：${storiesPath}；${error.message}` };
        }
        if (!stories || stories.managedBy !== MANAGED_BY) {
            return {
                ok: false,
                code: 'REQUIREMENT_STORIES_BUILDER_RECEIPT_REQUIRED',
                message: `stories.json 不是 Builder 落盘（缺少 managedBy=${MANAGED_BY}）。请调用 req_stories_submit 由 Builder 落盘，禁止手写。`
            };
        }
        if (!receiptPath || !fs.existsSync(receiptPath)) {
            return { ok: false, code: 'REQUIREMENT_STORIES_SUBMIT_RECEIPT_MISSING',
                message: `缺少 Builder 提交凭证：${receiptPath}` };
        }
        let receipt = null;
        try {
            receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf-8'));
        } catch (error) {
            return { ok: false, code: 'REQUIREMENT_STORIES_SUBMIT_RECEIPT_INVALID',
                message: `Builder 提交凭证无法解析：${receiptPath}；${error.message}` };
        }
        if (receipt.ok !== true || String(receipt.status || '') !== 'submitted') {
            return { ok: false, code: 'REQUIREMENT_STORIES_SUBMIT_RECEIPT_NOT_READY',
                message: `Builder 提交凭证未处于 submitted 状态：${receiptPath}` };
        }
        const raw = fs.readFileSync(storiesPath, 'utf-8');
        const currentHash = `sha256:${crypto.createHash('sha256').update(raw, 'utf-8').digest('hex')}`;
        if (String(receipt.storyHash || '') !== currentHash) {
            return {
                ok: false,
                code: 'REQUIREMENT_STORIES_SUBMIT_RECEIPT_HASH_MISMATCH',
                message: 'stories.json 与 Builder 提交凭证 hash 不一致，请重新调用 req_stories_submit。',
                currentHash,
                receiptHash: receipt.storyHash || ''
            };
        }
        const codingFactIssues = this._collectCodingFactStructureIssues(stories.stories, {
            allowBuilderFields: true
        });
        if (codingFactIssues.length > 0) {
            const projectionInvalid = codingFactIssues.some(issue =>
                issue.code === 'REQUIREMENT_STORIES_BUILDER_CODING_FACT_ID_INVALID');
            return {
                ok: false,
                code: projectionInvalid
                    ? 'REQUIREMENT_STORIES_BUILDER_PROJECTION_INVALID'
                    : 'REQUIREMENT_STORIES_CODING_FACT_STRUCTURE_INVALID',
                message: projectionInvalid
                    ? 'stories.json 中 Builder 生成的编码事实标识不稳定；请重新调用 req_stories_submit 重建受管投影。'
                    : 'stories.json 中已填写的编码事实结构不合法；请修复 analysis-state.json.stories 后重新调用 req_stories_submit。',
                issues: codingFactIssues,
                nextActionCard: projectionInvalid
                    ? {
                        title: '重建受管 Story 投影',
                        stopAfter: false,
                        instruction: '不要修改 analysis-state 业务答案；重新调用 req_stories_submit，让 Builder 重建 stories.json 和提交凭证。'
                    }
                    : {
                        title: '修复 analysis-state Story 编码事实结构后重调 req_stories_submit',
                        stopAfter: false,
                        instruction: '只修已填写的 codingFactHandoff[]：每项只保留 factType、description 和可选 confirmedFacts[]。没有额外事实时删除整个字段。',
                        codingFactHandoffGuide: CODING_FACT_HANDOFF_GUIDE
                    }
            };
        }
        if (analysisStatePath && fs.existsSync(analysisStatePath)) {
            let analysisState = null;
            try {
                analysisState = JSON.parse(fs.readFileSync(analysisStatePath, 'utf-8'));
            } catch (_) {
                analysisState = null;
            }
            const ambiguityFactIssues = this._collectImplementationAuditLeakIssues(analysisState, stories.stories);
            if (ambiguityFactIssues.length > 0) {
                return {
                    ok: false,
                    code: 'REQUIREMENT_STORIES_CONFIRMED_AMBIGUITY_FACTS_INVALID',
                    message: 'stories.json 未完整吸收已确认模糊点的净化业务事实；请修复 analysis-state.json.stories 后重新调用 req_stories_submit。',
                    issues: ambiguityFactIssues,
                    nextActionCard: {
                        title: '清理Story中的实现审计文本',
                        stopAfter: false,
                        instruction: 'rawUserReply / implementationPreferenceAuditOnly 只保留在过程账本；Story只写GWT、不变量和条件业务事实。'
                    }
                };
            }
        }
        return { ok: true, receipt, currentHash, stories, refresh: refreshResult || null };
    }

    /**
     * 设计阶段读取入口：从 stories.json 按 storyId 取整 story 对象。
     * Builder 内部使用，不暴露给 LLM。
     */
    readStoriesByPath(storiesPath) {
        if (!storiesPath || !fs.existsSync(storiesPath)) return null;
        try {
            return JSON.parse(fs.readFileSync(storiesPath, 'utf-8'));
        } catch (_) {
            return null;
        }
    }

    // ─── helpers ──────────────────────────────────────────────────────────────

    _validateAuthoringStories(analysisState = null) {
        if (!analysisState || typeof analysisState !== 'object' || Array.isArray(analysisState)) return [];
        const rawStories = analysisState.stories;
        const issues = [];
        if (Array.isArray(rawStories)) {
            issues.push({
                code: 'REQUIREMENT_STORIES_AUTHORING_OBJECT_MAP_REQUIRED',
                field: 'stories',
                message: '公开 Story 只能写在 analysis-state.json.stories.US1 / stories.US2 对象键下；禁止使用 stories 数组或在 Story 内填写 storyId。',
                repair: '把每个数组元素移到 stories.USx 对象键下，删除元素内 storyId/id/code 等身份字段；不改变业务字段内容。'
            });
            return issues;
        }
        if (!rawStories || typeof rawStories !== 'object') return issues;
        Object.keys(rawStories).forEach(key => {
            this.authoringDefinition.validate(rawStories[key], this._normalizeStoryId(key) || key)
                .forEach(issue => issues.push(issue));
        });
        return issues;
    }

    _extractStoriesFromAnalysisState(analysisState = null) {
        if (!analysisState || typeof analysisState !== 'object') return [];
        const rawStories = analysisState.stories;
        const orderedKeys = Array.isArray(analysisState.storyIds)
            ? analysisState.storyIds.map(id => this._normalizeStoryId(id)).filter(Boolean)
            : [];
        const byId = new Map();
        const appendStory = (story, fallbackId = '') => {
            if (!story || typeof story !== 'object' || Array.isArray(story)) return;
            const storyId = this._normalizeStoryId(fallbackId || story.storyId || story.storyID || story.id || story.code);
            if (!storyId) return;
            byId.set(storyId, this._normalizeAnalysisStateStoryForSubmit(story, storyId));
        };

        if (rawStories && typeof rawStories === 'object' && !Array.isArray(rawStories)) {
            Object.keys(rawStories).forEach(key => {
                const value = rawStories[key];
                appendStory(value, key);
            });
        }

        const out = [];
        orderedKeys.forEach(storyId => {
            if (!byId.has(storyId)) return;
            out.push(byId.get(storyId));
            byId.delete(storyId);
        });
        Array.from(byId.keys())
            .sort((left, right) => this._compareStoryIds(left, right))
            .forEach(storyId => out.push(byId.get(storyId)));
        return out;
    }

    _buildStorySourceDigest(analysisState = null, inputStories = []) {
        return `sha256:${crypto.createHash('sha256')
            .update(this._stableJsonStringify(this._buildStorySourceDigestPayload(analysisState, inputStories)), 'utf-8')
            .digest('hex')}`;
    }

    _buildStorySourceDigestPayload(analysisState = null, inputStories = []) {
        const storyIds = (Array.isArray(inputStories) ? inputStories : [])
            .map(story => this._normalizeStoryId(story && story.storyId))
            .filter(Boolean);
        const storySet = new Set(storyIds);
        const confirmedAmbiguities = [];
        this._collectAmbiguityItems(analysisState || {}).forEach(item => {
            if (!this._isConfirmedAmbiguity(item)) return;
            const affectedStoryIds = this._affectedStoryIds(item)
                .filter(storyId => !storySet.size || storySet.has(storyId));
            if (affectedStoryIds.length === 0) return;
            confirmedAmbiguities.push({
                identity: this._ambiguityIdentity(item),
                sourceId: this._ambiguitySourceId(item),
                status: String(item.status || item.confirmStatus || '').trim(),
                cardType: String(item.cardType || item.type || item.category || '').trim(),
                businessDecision: this._ambiguityBusinessDecision(item),
                flowImpact: this._ambiguityFlowImpact(item),
                affectsStories: affectedStoryIds
            });
        });
        confirmedAmbiguities.sort((left, right) =>
            `${left.sourceId || left.identity}`.localeCompare(`${right.sourceId || right.identity}`));

        return {
            schemaVersion: 'requirement-story-source-digest/v1',
            stories: Array.isArray(inputStories) ? inputStories : [],
            confirmedAmbiguities
        };
    }

    _stableJsonStringify(value) {
        const normalize = item => {
            if (Array.isArray(item)) return item.map(normalize);
            if (!item || typeof item !== 'object') return item;
            const out = {};
            Object.keys(item).sort().forEach(key => {
                const value = item[key];
                if (typeof value === 'undefined') return;
                out[key] = normalize(value);
            });
            return out;
        };
        return JSON.stringify(normalize(value));
    }

    _normalizeAnalysisStateStoryForSubmit(story = {}, storyId = '') {
        const out = { ...story, storyId };
        if (Array.isArray(out.codingFactHandoff) && out.codingFactHandoff.length === 0) {
            delete out.codingFactHandoff;
        }
        return out;
    }

    _compareStoryIds(left = '', right = '') {
        const l = this._normalizeStoryId(left);
        const r = this._normalizeStoryId(right);
        const lMatch = l.match(/^US(\d+)$/);
        const rMatch = r.match(/^US(\d+)$/);
        if (lMatch && rMatch) {
            return Number(lMatch[1]) - Number(rMatch[1]);
        }
        return l.localeCompare(r);
    }

    _normalizeStory(story = {}, projectPath = '', scanCatalog = null) {
        const storyId = String(story.storyId || '').trim().toUpperCase();
        const authored = { ...story };
        delete authored.storyId;
        const projection = this.authoringDefinition.project(authored, storyId, {
            existingAdjustment: (_value, _id, source) => {
                const entryFiles = this._normalizeExistingEntryFiles(source, projectPath, scanCatalog);
                const preserveBehaviors = this._normalizeExistingPreserveBehaviors(source);
                const existingAdjustment = {};
                if (entryFiles.length > 0) existingAdjustment.entryFiles = entryFiles;
                if (preserveBehaviors.length > 0) existingAdjustment.preserveBehaviors = preserveBehaviors;
                return Object.keys(existingAdjustment).length > 0 ? existingAdjustment : undefined;
            },
            codingFactHandoff: (_value, id, source) => {
                const rows = this._normalizeCodingFactHandoff(source, id);
                return rows.length > 0 ? rows : undefined;
            },
            workflowIntent: value => this._normalizeWorkflowIntent(value, storyId)
        });
        const source = projection.ok ? projection.story : authored;
        const ac = source.acceptanceCriteria || {};
        const normalizeGroup = (arr) => Array.isArray(arr)
            ? arr.map(gwt => ({
                scenario: String(gwt && gwt.scenario || '').trim(),
                given: String(gwt && gwt.given || '').trim(),
                when: String(gwt && gwt.when || '').trim(),
                then: String(gwt && gwt.then || '').trim()
            }))
            : [];
        const normalized = {
            storyId,
            actor: String(source.actor || '').trim(),
            userStory: String(source.userStory || '').trim(),
            acceptanceCriteria: {
                happyPath: normalizeGroup(ac.happyPath),
                exception: normalizeGroup(ac.exception),
                boundary: normalizeGroup(ac.boundary)
            },
            invariants: Array.isArray(source.invariants)
                ? source.invariants.map(item => String(item || '').trim()).filter(Boolean)
                : []
        };
        const deliveryBoundary = String(source.deliveryBoundary || '').trim().toLowerCase();
        if (deliveryBoundary) normalized.deliveryBoundary = deliveryBoundary;
        if (source.existingAdjustment) normalized.existingAdjustment = source.existingAdjustment;
        if (Array.isArray(source.codingFactHandoff) && source.codingFactHandoff.length > 0) normalized.codingFactHandoff = source.codingFactHandoff;
        if (source.statisticsIntent) normalized.statisticsIntent = source.statisticsIntent;
        if (source.workflowIntent) normalized.workflowIntent = source.workflowIntent;
        return normalized;
    }

    _validateDeliveryBoundary(story = {}, idx = 0, storyId = '', issues = []) {
        if (!story || !Object.prototype.hasOwnProperty.call(story, 'deliveryBoundary')) return;
        const value = String(story.deliveryBoundary || '').trim().toLowerCase();
        if (ALLOWED_DELIVERY_BOUNDARIES.has(value)) return;
        issues.push({
            code: 'REQUIREMENT_STORIES_SUBMIT_DELIVERY_BOUNDARY_INVALID',
            field: `stories[${idx}].deliveryBoundary`,
            storyId,
            message: `deliveryBoundary=${value || '(empty)'} 不合法。`,
            allowedValues: Array.from(ALLOWED_DELIVERY_BOUNDARIES),
            repair: '只有跨团队、跨系统或明确无 UI 时填写；从 current_team_ui / external_team_ui / inbound_system_api / outbound_external_api / no_ui 中选择。普通当前团队管理端 Story 删除该字段。'
        });
    }

    _validateStatisticsIntent(story = {}, idx = 0, storyId = '', issues = []) {
        if (!story || !Object.prototype.hasOwnProperty.call(story, 'statisticsIntent')) return;
        const intent = story.statisticsIntent;
        if (!intent || typeof intent !== 'object' || Array.isArray(intent)) {
            issues.push({
                code: 'REQUIREMENT_STORIES_SUBMIT_STATISTICS_INTENT_TYPE_INVALID',
                field: `stories[${idx}].statisticsIntent`,
                storyId,
                message: 'statisticsIntent 出现时必须是 object。统计/分析/汇总/报表类 Story 必须在需求阶段写清统计口径。',
                repair: '把统计业务口径写入 statisticsIntent:{title,purpose,filters,dimensions,metrics,display,exportRequired};不要等设计阶段补 statisticsContract。'
            });
            return;
        }
        ['title', 'purpose'].forEach(field => {
            if (!String(intent[field] || '').trim()) {
                issues.push({
                    code: 'REQUIREMENT_STORIES_SUBMIT_STATISTICS_INTENT_FIELD_MISSING',
                    field: `stories[${idx}].statisticsIntent.${field}`,
                    storyId,
                    message: `statisticsIntent.${field} 必填。`
                });
            }
        });
        ['filters', 'dimensions'].forEach(field => {
            if (intent[field] !== undefined && !Array.isArray(intent[field])) {
                issues.push({
                    code: 'REQUIREMENT_STORIES_SUBMIT_STATISTICS_INTENT_ARRAY_FIELD_INVALID',
                    field: `stories[${idx}].statisticsIntent.${field}`,
                    storyId,
                    message: `statisticsIntent.${field} 若出现必须是数组。`
                });
            }
        });
        const metrics = Array.isArray(intent.metrics) ? intent.metrics : [];
        if (metrics.length === 0) {
            issues.push({
                code: 'REQUIREMENT_STORIES_SUBMIT_STATISTICS_INTENT_METRICS_EMPTY',
                field: `stories[${idx}].statisticsIntent.metrics`,
                storyId,
                message: 'statisticsIntent.metrics 至少 1 项；统计分析 Story 必须在需求阶段明确指标口径。'
            });
        }
        metrics.forEach((metric, metricIdx) => {
            if (!metric || typeof metric !== 'object' || Array.isArray(metric)) {
                issues.push({
                    code: 'REQUIREMENT_STORIES_SUBMIT_STATISTICS_INTENT_METRIC_TYPE_INVALID',
                    field: `stories[${idx}].statisticsIntent.metrics[${metricIdx}]`,
                    storyId,
                    message: 'statisticsIntent.metrics[] 每项必须是 object。'
                });
                return;
            }
            ['label', 'aggregate'].forEach(field => {
                if (!String(metric[field] || '').trim()) {
                    issues.push({
                        code: 'REQUIREMENT_STORIES_SUBMIT_STATISTICS_INTENT_METRIC_FIELD_MISSING',
                        field: `stories[${idx}].statisticsIntent.metrics[${metricIdx}].${field}`,
                        storyId,
                        message: `statisticsIntent.metrics[].${field} 必填。`
                    });
                }
            });
        });
        if (intent.display !== undefined && (!intent.display || typeof intent.display !== 'object' || Array.isArray(intent.display))) {
            issues.push({
                code: 'REQUIREMENT_STORIES_SUBMIT_STATISTICS_INTENT_DISPLAY_INVALID',
                field: `stories[${idx}].statisticsIntent.display`,
                storyId,
                message: 'statisticsIntent.display 若出现必须是 object。'
            });
        }
        if (intent.exportRequired !== undefined && typeof intent.exportRequired !== 'boolean') {
            issues.push({
                code: 'REQUIREMENT_STORIES_SUBMIT_STATISTICS_INTENT_EXPORT_REQUIRED_INVALID',
                field: `stories[${idx}].statisticsIntent.exportRequired`,
                storyId,
                message: 'statisticsIntent.exportRequired 若出现必须是 boolean。'
            });
        }
    }

    _stableContractKey(prefix, seed) {
        const hash = crypto.createHash('sha256').update(String(seed || ''), 'utf-8').digest('hex').slice(0, 10);
        return `${prefix}_${hash}`;
    }

    _validateWorkflowIntent(story = {}, idx = 0, storyId = '', issues = []) {
        if (!story || !Object.prototype.hasOwnProperty.call(story, 'workflowIntent')) return;
        const intent = story.workflowIntent;
        const fieldBase = `stories[${idx}].workflowIntent`;
        if (!intent || typeof intent !== 'object' || Array.isArray(intent)) {
            issues.push({
                code: 'REQUIREMENT_STORIES_SUBMIT_WORKFLOW_INTENT_TYPE_INVALID',
                field: fieldBase,
                storyId,
                message: 'workflowIntent 出现时必须是 object。工作流 Story 必须在需求阶段写清流程业务事实。',
                repair: '把工作流业务事实写入 workflowIntent:{processName,starter,activities,transitions,businessResults};不要等设计阶段补 workflowContract。'
            });
            return;
        }

        if (!String(intent.processName || '').trim()) {
            issues.push({
                code: 'REQUIREMENT_STORIES_SUBMIT_WORKFLOW_INTENT_PROCESS_NAME_MISSING',
                field: `${fieldBase}.processName`,
                storyId,
                message: 'workflowIntent.processName 必填。'
            });
        }
        if (!Array.isArray(intent.activities) || intent.activities.length === 0) {
            issues.push({
                code: 'REQUIREMENT_STORIES_SUBMIT_WORKFLOW_INTENT_ACTIVITIES_EMPTY',
                field: `${fieldBase}.activities`,
                storyId,
                message: 'workflowIntent.activities 必须是非空数组，至少写清一个业务节点。'
            });
        }
        if (!Array.isArray(intent.transitions) || intent.transitions.length === 0) {
            issues.push({
                code: 'REQUIREMENT_STORIES_SUBMIT_WORKFLOW_INTENT_TRANSITIONS_EMPTY',
                field: `${fieldBase}.transitions`,
                storyId,
                message: 'workflowIntent.transitions 必须是非空数组，写清节点流转关系。'
            });
        }
        if (intent.businessResults !== undefined && !Array.isArray(intent.businessResults)) {
            issues.push({
                code: 'REQUIREMENT_STORIES_SUBMIT_WORKFLOW_INTENT_BUSINESS_RESULTS_INVALID',
                field: `${fieldBase}.businessResults`,
                storyId,
                message: 'workflowIntent.businessResults 若出现必须是字符串数组。'
            });
        }

        const activityRefs = new Set(['start', 'end']);
        const activityNames = [];
        const activities = Array.isArray(intent.activities) ? intent.activities : [];
        activities.forEach((activity, activityIdx) => {
            const activityField = `${fieldBase}.activities[${activityIdx}]`;
            if (!activity || typeof activity !== 'object' || Array.isArray(activity)) {
                issues.push({
                    code: 'REQUIREMENT_STORIES_SUBMIT_WORKFLOW_INTENT_ACTIVITY_TYPE_INVALID',
                    field: activityField,
                    storyId,
                    message: 'workflowIntent.activities[] 每项必须是对象。'
                });
                return;
            }
            ['name', 'actor'].forEach(key => {
                if (!String(activity[key] || '').trim()) {
                    issues.push({
                        code: 'REQUIREMENT_STORIES_SUBMIT_WORKFLOW_INTENT_ACTIVITY_FIELD_MISSING',
                        field: `${activityField}.${key}`,
                        storyId,
                        message: `workflowIntent.activities[].${key} 必填。`
                    });
                }
            });
            const name = String(activity.name || '').trim();
            const key = String(activity.key || '').trim();
            if (name) {
                activityRefs.add(name);
                activityNames.push(name);
            }
            if (key) activityRefs.add(key);
            if (activity.operations !== undefined && !Array.isArray(activity.operations)) {
                issues.push({
                    code: 'REQUIREMENT_STORIES_SUBMIT_WORKFLOW_INTENT_ACTIVITY_OPERATIONS_INVALID',
                    field: `${activityField}.operations`,
                    storyId,
                    message: 'workflowIntent.activities[].operations 若出现必须是数组。'
                });
            } else if (Array.isArray(activity.operations)) {
                activity.operations.forEach((operation, operationIdx) => {
                    const operationField = `${activityField}.operations[${operationIdx}]`;
                    if (typeof operation === 'string') {
                        if (!operation.trim()) {
                            issues.push({
                                code: 'REQUIREMENT_STORIES_SUBMIT_WORKFLOW_INTENT_OPERATION_NAME_MISSING',
                                field: operationField,
                                storyId,
                                message: '工作流操作名称不能为空。'
                            });
                        }
                        return;
                    }
                    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
                        issues.push({
                            code: 'REQUIREMENT_STORIES_SUBMIT_WORKFLOW_INTENT_OPERATION_TYPE_INVALID',
                            field: operationField,
                            storyId,
                            message: 'workflowIntent.activities[].operations[] 必须是操作名称字符串或对象。'
                        });
                        return;
                    }
                    if (!String(operation.name || '').trim()) {
                        issues.push({
                            code: 'REQUIREMENT_STORIES_SUBMIT_WORKFLOW_INTENT_OPERATION_NAME_MISSING',
                            field: `${operationField}.name`,
                            storyId,
                            message: '工作流操作对象的name必填。'
                        });
                    }
                    const semantic = String(operation.semantic || operation.type || '').trim().toLowerCase();
                    if (semantic && !WORKFLOW_OPERATION_SEMANTICS.includes(semantic)) {
                        issues.push({
                            code: 'REQUIREMENT_STORIES_SUBMIT_WORKFLOW_INTENT_OPERATION_SEMANTIC_INVALID',
                            field: `${operationField}.semantic`,
                            storyId,
                            message: `工作流操作semantic只能是${WORKFLOW_OPERATION_SEMANTICS.join('、')}。`,
                            allowedValues: WORKFLOW_OPERATION_SEMANTICS
                        });
                    }
                    if (operation.targetActivity !== undefined && typeof operation.targetActivity !== 'string') {
                        issues.push({
                            code: 'REQUIREMENT_STORIES_SUBMIT_WORKFLOW_INTENT_OPERATION_TARGET_INVALID',
                            field: `${operationField}.targetActivity`,
                            storyId,
                            message: 'targetActivity若出现必须是节点名称字符串。'
                        });
                    }
                    if (operation.requiresOpinion !== undefined && typeof operation.requiresOpinion !== 'boolean') {
                        issues.push({
                            code: 'REQUIREMENT_STORIES_SUBMIT_WORKFLOW_INTENT_OPERATION_OPINION_INVALID',
                            field: `${operationField}.requiresOpinion`,
                            storyId,
                            message: 'requiresOpinion若出现必须是boolean。'
                        });
                    }
                });
            }
        });

        const transitionCandidates = Array.from(new Set(['start', 'end', ...activityNames]));

        const hasWorkflowOperation = activities.some(activity =>
            Array.isArray(activity && activity.operations) && activity.operations.length > 0
        );
        if (activities.length > 0 && !hasWorkflowOperation) {
            issues.push({
                code: 'REQUIREMENT_STORIES_SUBMIT_WORKFLOW_INTENT_OPERATIONS_EMPTY',
                field: `${fieldBase}.activities`,
                storyId,
                message: '工作流至少要有一个流程引擎操作；查看、填写、上传等页面能力不要写成操作。',
                repair: '在对应节点operations中补充真实流程操作名称；需要区分保存、提交、通过、退回时可给操作对象增加semantic。'
            });
        }

        const transitions = Array.isArray(intent.transitions) ? intent.transitions : [];
        transitions.forEach((transition, transitionIdx) => {
            const transitionField = `${fieldBase}.transitions[${transitionIdx}]`;
            if (!transition || typeof transition !== 'object' || Array.isArray(transition)) {
                issues.push({
                    code: 'REQUIREMENT_STORIES_SUBMIT_WORKFLOW_INTENT_TRANSITION_TYPE_INVALID',
                    field: transitionField,
                    storyId,
                    message: 'workflowIntent.transitions[] 每项必须是对象。'
                });
                return;
            }
            ['from', 'to'].forEach(key => {
                const value = String(transition[key] || '').trim();
                if (!value) {
                    issues.push({
                        code: 'REQUIREMENT_STORIES_SUBMIT_WORKFLOW_INTENT_TRANSITION_FIELD_MISSING',
                        field: `${transitionField}.${key}`,
                        storyId,
                        message: `workflowIntent.transitions[].${key} 必填。`
                    });
                    return;
                }
                if (!activityRefs.has(value)) {
                    issues.push({
                        code: 'REQUIREMENT_STORIES_SUBMIT_WORKFLOW_INTENT_TRANSITION_REF_UNKNOWN',
                        field: `${transitionField}.${key}`,
                        storyId,
                        message: `workflowIntent.transitions[].${key}="${value}" 未引用 start/end 或 activities[].name。`,
                        allowedValues: transitionCandidates,
                        repair: `将 ${transitionField}.${key} 改为以下节点之一：${transitionCandidates.join('、')}。若“${value}”表达对象状态或业务结果，移到 GWT、不变量或 businessResults；若它本意是办理节点，先补到 activities[].name，再在 transitions 引用该精确名称。`
                    });
                }
            });
        });
    }

    _normalizeWorkflowIntent(value = null, storyId = '') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const stripEmpty = (obj = {}) => {
            const out = {};
            Object.keys(obj || {}).forEach(key => {
                const item = obj[key];
                if (item === undefined || item === null || item === '') return;
                if (Array.isArray(item) && item.length === 0) return;
                if (item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === 0) return;
                out[key] = item;
            });
            return out;
        };
        const normalizeOperations = (items = []) => (Array.isArray(items) ? items : [])
            .map(item => {
                if (item && typeof item === 'object' && !Array.isArray(item)) {
                    return stripEmpty({
                        key: String(item.key || '').trim(),
                        name: String(item.name || '').trim(),
                        semantic: String(item.semantic || item.type || item.actionType || '').trim().toLowerCase(),
                        type: String(item.type || '').trim(),
                        operationType: String(item.operationType || '').trim(),
                        targetActivity: String(item.targetActivity || item.target || '').trim(),
                        requiresOpinion: item.requiresOpinion === true || item.isRequireOpinion === true,
                        checkMaterialSubmit: item.checkMaterialSubmit === true || item.isCheckMaterialSubmit === true
                    });
                }
                const text = String(item || '').trim();
                return text ? { name: text } : {};
            })
            .filter(item => Object.keys(item).length > 0);
        const rawActivities = (Array.isArray(value.activities) ? value.activities : [])
            .filter(item => item && typeof item === 'object' && !Array.isArray(item))
            .map(item => ({
                rawKey: String(item.key || '').trim(),
                name: String(item.name || '').trim(),
                actor: String(item.actor || '').trim(),
                type: String(item.type || '').trim(),
                operations: normalizeOperations(item.operations)
            }));
        const activityRefMap = new Map([['start', 'start'], ['end', 'end']]);
        const activities = rawActivities.map(item => {
            const key = this._stableContractKey('activity', `${storyId}|${item.name}|${item.actor}`);
            if (item.rawKey) activityRefMap.set(item.rawKey, key);
            if (item.name) activityRefMap.set(item.name, key);
            const operations = item.operations.map((operation, operationIndex) => ({
                ...operation,
                key: this._stableContractKey(
                    'operation',
                    `${storyId}|${key}|${operation.name || ''}|${operation.semantic || ''}|${operationIndex}`
                )
            }));
            return stripEmpty({
                key,
                name: item.name,
                actor: item.actor,
                type: item.type,
                operations
            });
        }).filter(item => Object.keys(item).length > 0);
        const transitions = (Array.isArray(value.transitions) ? value.transitions : [])
            .filter(item => item && typeof item === 'object' && !Array.isArray(item))
            .map(item => stripEmpty({
                from: activityRefMap.get(String(item.from || '').trim()) || String(item.from || '').trim(),
                to: activityRefMap.get(String(item.to || '').trim()) || String(item.to || '').trim(),
                condition: String(item.condition || '').trim()
            }))
            .filter(item => Object.keys(item).length > 0);
        const businessResults = (Array.isArray(value.businessResults) ? value.businessResults : [])
            .map(item => String(item || '').trim())
            .filter(Boolean);
        return stripEmpty({
            processName: String(value.processName || '').trim(),
            starter: String(value.starter || '').trim(),
            activities,
            transitions,
            businessResults
        });
    }

    _validateCodingFactHandoff(story = {}, idx = 0, storyId = '', issues = [], context = {}) {
        if (!story || !Object.prototype.hasOwnProperty.call(story, 'codingFactHandoff')) return;
        const raw = story.codingFactHandoff;
        if (!Array.isArray(raw)) {
            issues.push({
                code: 'REQUIREMENT_STORIES_SUBMIT_CODING_FACT_HANDOFF_NOT_ARRAY',
                field: `stories[${idx}].codingFactHandoff`,
                storyId,
                message: 'codingFactHandoff 若出现必须是数组;每项是一条已确认事实。',
                repair: '没有额外事实时删除该字段；有事实时每项只写factType、description和可选confirmedFacts[]。'
            });
            return;
        }
        if (raw.length === 0) {
            issues.push({
                code: 'REQUIREMENT_STORIES_SUBMIT_CODING_FACT_HANDOFF_EMPTY',
                field: `stories[${idx}].codingFactHandoff`,
                storyId,
                message: 'codingFactHandoff 已出现时至少包含 1 条事实;没有额外事实时请删除该字段。',
                repair: '删除空数组，或补一条包含factType + description的事实。'
            });
            return;
        }
        raw.forEach((item, factIdx) => {
            this._validateCodingFactHandoffItem(item, {
                fieldBase: `stories[${idx}].codingFactHandoff[${factIdx}]`,
                storyId,
                issues,
                ...context
            });
        });
    }

    _validateCodingFactHandoffItem(item = {}, context = {}) {
        const fieldBase = String(context.fieldBase || 'codingFactHandoff[]').trim();
        const storyId = String(context.storyId || '').trim();
        const issues = Array.isArray(context.issues) ? context.issues : [];
        const allowedKeys = new Set(CODING_FACT_HANDOFF_ALLOWED_KEYS);
        if (context.allowBuilderFields) allowedKeys.add('factId');
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            issues.push({
                code: 'REQUIREMENT_STORIES_SUBMIT_CODING_FACT_HANDOFF_ITEM_NOT_OBJECT',
                field: fieldBase,
                storyId,
                message: 'codingFactHandoff 每项必须是 object。',
                repair: '每项固定格式为 { factType, description, confirmedFacts? };不得写字符串或数组。'
            });
            return;
        }
        const unsupportedKeys = Object.keys(item).filter(key => !allowedKeys.has(key));
        if (unsupportedKeys.length > 0) {
            issues.push({
                code: 'REQUIREMENT_STORIES_SUBMIT_CODING_FACT_HANDOFF_UNSUPPORTED_FIELD',
                field: fieldBase,
                storyId,
                unsupportedFields: unsupportedKeys,
                message: `codingFactHandoff 只接受 factType/description/confirmedFacts；不接受 ${unsupportedKeys.join('/')}。`,
                repair: '只保留事实分类、事实正文和可选事实条目；factId与来源账务由Builder生成。'
            });
            return;
        }
        const normalized = this._normalizeCodingFactHandoffItem(item, storyId, 0);
        if (!normalized) {
            issues.push({
                code: 'REQUIREMENT_STORIES_SUBMIT_CODING_FACT_HANDOFF_ITEM_EMPTY',
                field: fieldBase,
                storyId,
                message: 'codingFactHandoff 事实项没有任何有效字段。',
                repair: '补 factType + description；有多条明细时再补 confirmedFacts[]。'
            });
            return;
        }
        if (context.allowBuilderFields && String(item.factId || '').trim() !== normalized.factId) {
            issues.push({
                code: 'REQUIREMENT_STORIES_BUILDER_CODING_FACT_ID_INVALID',
                field: `${fieldBase}.factId`,
                storyId,
                message: 'stories.json 中的 factId 不是 Builder 按 Story 和事实内容生成的稳定标识。',
                repair: '重新调用 req_stories_submit 重建 stories.json；不要手工修改受管 factId。'
            });
        }
        if (!String(normalized.description || '').trim()) {
            issues.push({
                code: 'REQUIREMENT_STORIES_SUBMIT_CODING_FACT_HANDOFF_DESCRIPTION_MISSING',
                field: `${fieldBase}.description`,
                storyId,
                message: 'codingFactHandoff 每条事实必须填写 description,用于承载 Coder 必须消费的已确认事实正文。',
                repair: '把事实正文写入 description；不要使用 fact、summary、value、content 等非合同字段。'
            });
        }
        ['factType', 'description'].forEach(key => {
            if (Object.prototype.hasOwnProperty.call(item, key)
                && typeof item[key] !== 'string') {
                issues.push({
                    code: 'REQUIREMENT_STORIES_SUBMIT_CODING_FACT_HANDOFF_STRING_FIELD_INVALID',
                    field: `${fieldBase}.${key}`,
                    storyId,
                    message: `codingFactHandoff.${key} 必须是字符串。`,
                    repair: `${key} 请写成字符串;如果没有确定内容就删除该字段,不要写对象、数组、数字或布尔值。`
                });
            }
        });
        ['confirmedFacts'].forEach(key => {
            if (!Object.prototype.hasOwnProperty.call(item, key)) return;
            if (!Array.isArray(item[key])) {
                issues.push({
                    code: 'REQUIREMENT_STORIES_SUBMIT_CODING_FACT_HANDOFF_ARRAY_FIELD_INVALID',
                    field: `${fieldBase}.${key}`,
                    storyId,
                    message: `codingFactHandoff.${key} 必须是字符串数组。`,
                    repair: `${key} 请写成 ["事实条目"] 这种字符串数组;如果没有条目就删除该字段。`
                });
                return;
            }
            item[key].forEach((value, valueIdx) => {
                if (typeof value !== 'string' || !String(value || '').trim()) {
                    issues.push({
                        code: 'REQUIREMENT_STORIES_SUBMIT_CODING_FACT_HANDOFF_ARRAY_ITEM_INVALID',
                        field: `${fieldBase}.${key}[${valueIdx}]`,
                        storyId,
                        message: `codingFactHandoff.${key}[${valueIdx}] 必须是非空字符串。`,
                        repair: `${key} 只能放非空字符串事实条目;删除空值或对象。`
                    });
                }
            });
        });
    }

    _collectCodingFactStructureIssues(stories = [], context = {}) {
        const issues = [];
        if (!Array.isArray(stories)) {
            issues.push({
                code: 'REQUIREMENT_STORIES_STORIES_NOT_ARRAY',
                field: 'stories',
                message: 'stories.json 中 stories 必须是数组。'
            });
            return issues;
        }
        stories.forEach((story, idx) => {
            const storyId = String(story && story.storyId || '').trim().toUpperCase();
            this._validateCodingFactHandoff(story, idx, storyId, issues, context);
        });
        return issues;
    }

    _ambiguityBusinessDecision(item = {}) {
        return String(
            item.businessDecision
            || item.businessDecisionSummary
            || item.businessConclusion
            || item.cleanBusinessDecision
            || ''
        ).trim();
    }

    _ambiguityFlowImpact(item = {}) {
        return String(
            item.flowImpact
            || item.businessFlowImpact
            || item.processImpact
            || ''
        ).trim();
    }

    _collectImplementationAuditLeakIssues(analysisState = null, stories = []) {
        if (!analysisState || typeof analysisState !== 'object' || !Array.isArray(stories)) return [];
        const allStoryIds = stories.map(story => this._normalizeStoryId(story && story.storyId)).filter(Boolean);
        const storyById = new Map(stories
            .map(story => [this._normalizeStoryId(story && story.storyId), story])
            .filter(([storyId]) => storyId));
        const issues = [];
        const seen = new Set();
        const pushIssue = issue => {
            const key = `${issue.code}|${issue.field}|${issue.auditText}`;
            if (seen.has(key)) return;
            seen.add(key);
            issues.push(issue);
        };
        this._collectAmbiguityItems(analysisState).forEach(item => {
            if (!this._isConfirmedAmbiguity(item)) return;
            const auditChunks = this._implementationAuditChunks(item);
            if (auditChunks.length === 0) return;
            const identity = this._ambiguityIdentity(item);
            const affectedStoryIds = this._affectedStoryIds(item);
            [
                {
                    field: `analysis-state.ambiguity(${identity}).businessDecision`,
                    text: item.businessDecision || item.businessDecisionSummary || item.businessConclusion || item.cleanBusinessDecision || ''
                },
                {
                    field: `analysis-state.ambiguity(${identity}).flowImpact`,
                    text: item.flowImpact || item.businessFlowImpact || item.processImpact || ''
                }
            ].forEach(slot => {
                this._auditChunksInText(auditChunks, slot.text).forEach(auditText => {
                    pushIssue(this._buildImplementationAuditLeakIssue({
                        field: slot.field,
                        ambiguity: identity,
                        auditText
                    }));
                });
            });
            const targetStoryIds = affectedStoryIds.length > 0 ? affectedStoryIds : allStoryIds;
            targetStoryIds.forEach(storyId => {
                const story = storyById.get(storyId);
                if (!story) return;
                this._storyBusinessFactSlots(story, storyId).forEach(slot => {
                    this._auditChunksInText(auditChunks, slot.text).forEach(auditText => {
                        pushIssue(this._buildImplementationAuditLeakIssue({
                            field: slot.field,
                            storyId,
                            ambiguity: identity,
                            auditText
                        }));
                    });
                });
            });
        });
        return issues;
    }

    _buildImplementationAuditLeakIssue({ field = '', storyId = '', ambiguity = '', auditText = '' } = {}) {
        return {
            code: 'REQUIREMENT_STORIES_IMPLEMENTATION_AUDIT_LEAKED_TO_BUSINESS_FACTS',
            field,
            ...(storyId ? { storyId } : {}),
            ambiguity,
            auditText,
            message: 'implementationPreferenceAuditOnly 中的审计表达被写入了下游业务事实槽，无法证明实现偏好已和业务事实分离。',
            repair: '保留该表达在 implementationPreferenceAuditOnly 作为审计；Story的GWT、不变量和条件业务事实只写用户可验证结果。'
        };
    }

    _implementationAuditChunks(item = {}) {
        const raw = item && item.implementationPreferenceAuditOnly;
        const chunks = [];
        const visit = value => {
            if (value === null || typeof value === 'undefined') return;
            if (Array.isArray(value)) {
                value.forEach(visit);
                return;
            }
            if (typeof value === 'object') {
                Object.keys(value).forEach(key => visit(value[key]));
                return;
            }
            String(value || '')
                .split(/[、,，;；/|]/u)
                .map(text => text.trim())
                .filter(text => this._isMeaningfulAuditChunk(text))
                .forEach(text => {
                    if (!chunks.includes(text)) chunks.push(text);
                });
        };
        visit(raw);
        return chunks;
    }

    _isMeaningfulAuditChunk(text = '') {
        const normalized = String(text || '').trim();
        if (!normalized) return false;
        if (/^[A-Z]$/i.test(normalized)) return false;
        if (/^(?:无|无关|不涉及|未提及|unknown|none|null)$/i.test(normalized)) return false;
        if (/[\u4e00-\u9fa5]/u.test(normalized)) return normalized.length >= 2;
        return normalized.length >= 4;
    }

    _auditChunksInText(chunks = [], text = '') {
        const normalizedText = this._normalizeAuditCompareText(text);
        if (!normalizedText) return [];
        return chunks.filter(chunk => {
            const normalizedChunk = this._normalizeAuditCompareText(chunk);
            return normalizedChunk && normalizedText.includes(normalizedChunk);
        });
    }

    _normalizeAuditCompareText(text = '') {
        return String(text || '').replace(/\s+/g, '').toLowerCase();
    }

    _storyBusinessFactSlots(story = {}, storyId = '') {
        const slots = [];
        const add = (field, text) => {
            const value = String(text || '').trim();
            if (value) slots.push({ field, text: value });
        };
        add(`stories.${storyId}.userStory`, story.userStory);
        this._collectTextSlots(story.acceptanceCriteria, `stories.${storyId}.acceptanceCriteria`, slots);
        this._collectTextSlots(story.invariants, `stories.${storyId}.invariants`, slots);
        this._collectTextSlots(story.codingFactHandoff, `stories.${storyId}.codingFactHandoff`, slots, {
            skipKeys: new Set(['factId'])
        });
        this._collectTextSlots(
            story && story.existingAdjustment && story.existingAdjustment.preserveBehaviors,
            `stories.${storyId}.existingAdjustment.preserveBehaviors`,
            slots
        );
        return slots;
    }

    _collectTextSlots(value, basePath, out, options = {}) {
        if (value === null || typeof value === 'undefined') return;
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            const text = String(value || '').trim();
            if (text) out.push({ field: basePath, text });
            return;
        }
        if (Array.isArray(value)) {
            value.forEach((item, idx) => this._collectTextSlots(item, `${basePath}[${idx}]`, out, options));
            return;
        }
        if (typeof value === 'object') {
            Object.keys(value).forEach(key => {
                if (options.skipKeys && options.skipKeys.has(key)) return;
                this._collectTextSlots(value[key], `${basePath}.${key}`, out, options);
            });
        }
    }

    _collectAmbiguityItems(analysisState = {}) {
        const out = [];
        const visit = value => {
            if (!value) return;
            if (Array.isArray(value)) {
                value.forEach(visit);
                return;
            }
            if (typeof value !== 'object') return;
            const hasIdentity = this._ambiguityIdentity(value);
            const hasStatus = Object.prototype.hasOwnProperty.call(value, 'status')
                || Object.prototype.hasOwnProperty.call(value, 'confirmStatus');
            if (hasIdentity && hasStatus) out.push(value);
            if (Object.prototype.hasOwnProperty.call(value, 'decisions')) visit(value.decisions);
            if (Object.prototype.hasOwnProperty.call(value, 'decision')) visit(value.decision);
        };
        visit(analysisState.ambiguityCards);
        visit(analysisState.ambiguityPoints);
        return out;
    }

    _isConfirmedAmbiguity(item = {}) {
        return ['confirmed', 'done', 'completed', '已确认', '已完成', 'resolved']
            .includes(String(item && (item.status || item.confirmStatus) || '').trim().toLowerCase());
    }

    _ambiguityIdentity(item = {}) {
        return String(item && (item.id || item.ambiguityId || item.fuzzyPoint || item.question || item.title) || '').trim();
    }

    _ambiguitySourceId(item = {}) {
        return String(item && (item.id || item.ambiguityId) || '').trim() || this._ambiguityIdentity(item);
    }

    _affectedStoryIds(item = {}) {
        const out = [];
        [
            'affectsStories',
            'affectedStories',
            'relatedStoryIds',
            'storyIds',
            'sourceStoryIds',
            'impactedStoryIds'
        ].forEach(field => {
            this._collectStoryRefs(item && item[field]).forEach(storyId => {
                if (!out.includes(storyId)) out.push(storyId);
            });
        });
        return out;
    }

    _collectStoryRefs(value) {
        const out = [];
        const pushRef = raw => {
            const matches = String(raw || '').trim().toUpperCase().match(/\bUS[_-]?\d+\b/g) || [];
            matches.forEach(match => {
                const storyId = this._normalizeStoryId(match);
                if (storyId && !out.includes(storyId)) out.push(storyId);
            });
        };
        const visit = val => {
            if (!val) return;
            if (Array.isArray(val)) {
                val.forEach(visit);
                return;
            }
            if (typeof val === 'object') {
                [
                    'storyId',
                    'storyID',
                    'story',
                    'id',
                    'value',
                    'code',
                    'sourceStoryId',
                    'sourceStoryIds',
                    'relatedStoryId',
                    'relatedStoryIds',
                    'affectedStoryId',
                    'affectedStoryIds',
                    'impactedStoryId',
                    'impactedStoryIds',
                    'storyIds',
                    'stories'
                ].forEach(key => {
                    if (Object.prototype.hasOwnProperty.call(val, key)) visit(val[key]);
                });
                return;
            }
            pushRef(val);
        };
        visit(value);
        return out;
    }

    _normalizeStoryId(value) {
        return String(value || '').trim().toUpperCase().replace(/^US[_-]?/i, 'US');
    }

    _readJsonSafe(filePath = '') {
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch (_) {
            return null;
        }
    }

    _normalizeCodingFactHandoff(story = {}, storyId = '') {
        const raw = Array.isArray(story && story.codingFactHandoff) ? story.codingFactHandoff : [];
        const out = [];
        const seen = new Set();
        raw.forEach((item, idx) => {
            const normalized = this._normalizeCodingFactHandoffItem(item, storyId, idx);
            if (!normalized) return;
            const key = `${normalized.factType || ''}::${normalized.description || ''}`;
            if (seen.has(key)) return;
            seen.add(key);
            out.push(normalized);
        });
        return out;
    }

    _normalizeCodingFactHandoffItem(item = {}, storyId = '', idx = 0) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
        const out = {};
        const factType = String(item.factType || '').trim();
        const description = String(item.description || '').trim();
        if (!description) return null;
        out.factId = `${String(storyId || 'US').trim().toUpperCase()}-CF-${crypto.createHash('sha256')
            .update(`${String(storyId || '').trim().toUpperCase()}|${factType}|${description}`, 'utf-8')
            .digest('hex').slice(0, 10).toUpperCase()}`;
        if (factType) out.factType = factType;
        out.description = description;
        const confirmedFacts = this._normalizeFlexibleStringArray(item.confirmedFacts);
        if (confirmedFacts.length > 0) out.confirmedFacts = confirmedFacts;
        return out;
    }

    _normalizeFlexibleStringArray(value) {
        const out = [];
        const seen = new Set();
        const visit = item => {
            if (item === null || typeof item === 'undefined') return;
            if (Array.isArray(item)) {
                item.forEach(visit);
                return;
            }
            const text = String(item || '').trim();
            if (!text || seen.has(text)) return;
            seen.add(text);
            out.push(text);
        };
        visit(value);
        return out;
    }

    _storyHasAcceptanceCriteria(story = {}) {
        const ac = story && story.acceptanceCriteria && typeof story.acceptanceCriteria === 'object' && !Array.isArray(story.acceptanceCriteria)
            ? story.acceptanceCriteria
            : null;
        if (!ac) return false;
        return ['happyPath', 'exception', 'boundary'].some(group => Array.isArray(ac[group]) && ac[group].length > 0);
    }

    _copyTrimmedString(source = {}, target = {}, key = '') {
        const value = String(source && source[key] || '').trim();
        if (value) target[key] = value;
    }

    _copyTrimmedStringArray(source = {}, target = {}, key = '') {
        const raw = Array.isArray(source && source[key]) ? source[key] : [];
        const out = [];
        const seen = new Set();
        raw.map(item => String(item || '').trim()).filter(Boolean).forEach(item => {
            if (seen.has(item)) return;
            seen.add(item);
            out.push(item);
        });
        if (out.length > 0) target[key] = out;
    }

    _rawExistingAdjustment(story = {}) {
        return story && story.existingAdjustment && typeof story.existingAdjustment === 'object' && !Array.isArray(story.existingAdjustment)
            ? story.existingAdjustment
            : {};
    }

    _rawExistingEntryFiles(story = {}) {
        const existing = this._rawExistingAdjustment(story);
        return Array.isArray(existing.entryFiles) ? existing.entryFiles : [];
    }

    _rawExistingPreserveBehaviorsValue(story = {}) {
        const existing = this._rawExistingAdjustment(story);
        return Object.prototype.hasOwnProperty.call(existing, 'preserveBehaviors')
            ? existing.preserveBehaviors
            : undefined;
    }

    _normalizeExistingEntryFiles(story = {}, projectPath = '', scanCatalog = null) {
        const out = [];
        const seen = new Set();
        for (const entry of this._rawExistingEntryFiles(story)) {
            const resolution = this._resolveExistingEntryReference(entry, projectPath, scanCatalog);
            if (!resolution.ok) continue;
            this._appendNormalizedEntry(out, seen, resolution.entry);
            if (resolution.entry.fileKind === 'HtmlPage') {
                for (const actionEntry of this._routeActionEntriesForHtml(resolution.relativePath, scanCatalog)) {
                    this._appendNormalizedEntry(out, seen, actionEntry);
                }
            }
        }
        return out;
    }

    _appendNormalizedEntry(out, seen, entry) {
        if (!entry || !entry.fileKind || !entry.path) return;
        const key = `${entry.fileKind}::${entry.path}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({
            fileKind: entry.fileKind,
            path: entry.path,
            source: entry.source || 'user_provided',
            verificationStatus: entry.verificationStatus || 'verified'
        });
    }

    _normalizeExistingPreserveBehaviors(story = {}) {
        const raw = this._rawExistingPreserveBehaviorsValue(story);
        const out = [];
        const seen = new Set();
        for (const item of (Array.isArray(raw) ? raw : [])) {
            if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
            const businessResult = String(item.businessResult || '').trim();
            const regressionScope = String(item.regressionScope || '').trim();
            if (!businessResult) continue;
            const key = `${businessResult}::${regressionScope}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({
                businessResult,
                ...(regressionScope ? { regressionScope } : {})
            });
        }
        return out;
    }

    _resolveEntryPathWithinProject(projectPath, entryPath) {
        const projectRoot = path.resolve(String(projectPath || '').trim());
        const rawPath = String(entryPath || '').trim();
        if (!projectRoot || !rawPath || rawPath.indexOf('\0') !== -1) return '';
        const resolvedPath = path.isAbsolute(rawPath)
            ? path.resolve(rawPath)
            : path.resolve(projectRoot, rawPath);
        const relative = path.relative(projectRoot, resolvedPath);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return '';
        return resolvedPath;
    }

    _resolveExistingEntryReference(entry = {}, projectPath = '', scanCatalog = null) {
        const fileKind = String(entry && entry.fileKind || '').trim();
        const rawPath = String(entry && (entry.path || entry.resolvedPath || entry.filePath) || '').trim();
        const resolvedPath = this._resolveEntryPathWithinProject(projectPath, rawPath);
        if (!ALLOWED_EXISTING_ENTRY_FILE_KINDS.has(fileKind) || !resolvedPath) {
            return {
                ok: false,
                code: 'REQUIREMENT_STORIES_SUBMIT_EXISTING_ADJUSTMENT_ENTRY_FILE_NOT_VERIFIED',
                message: '历史功能调整入口文件必须是真实存在的 HtmlPage/Action，或能从项目勘测结果唯一匹配到真实入口。',
                repair: '请填写真实存在的 HtmlPage/Action 入口；如果只知道页面名，先填用户已确认的页面名或入口线索，系统会在项目勘测结果唯一匹配时自动纠正。'
            };
        }
        const projectRoot = path.resolve(String(projectPath || '').trim());
        if (fs.existsSync(resolvedPath)) {
            return {
                ok: true,
                relativePath: this._normalizeRelativePath(path.relative(projectRoot, resolvedPath)),
                entry: {
                    fileKind,
                    path: resolvedPath,
                    source: 'user_provided',
                    verificationStatus: 'verified'
                }
            };
        }
        const matches = this._findScanEntryMatches(fileKind, rawPath, resolvedPath, projectPath, scanCatalog);
        if (matches.length === 1) {
            const matched = matches[0];
            if (!fs.existsSync(matched.path)) {
                return {
                    ok: false,
                    code: 'REQUIREMENT_STORIES_SUBMIT_EXISTING_ADJUSTMENT_ENTRY_FILE_NOT_VERIFIED',
                    message: '项目勘测结果命中了历史入口，但当前项目中该文件不存在；请重新勘测或确认真实入口文件。',
                    repair: '请填写当前项目中真实存在的 HtmlPage/Action 入口，或先刷新项目勘测后再重调 req_stories_submit。'
                };
            }
            return {
                ok: true,
                relativePath: matched.relativePath,
                entry: {
                    fileKind: matched.fileKind,
                    path: matched.path,
                    source: 'scan_resolved',
                    verificationStatus: 'verified'
                }
            };
        }
        if (matches.length > 1) {
            return {
                ok: false,
                code: 'REQUIREMENT_STORIES_SUBMIT_EXISTING_ADJUSTMENT_ENTRY_FILE_AMBIGUOUS',
                message: '历史功能调整入口文件匹配到多个项目入口，无法唯一确认真实 HtmlPage/Action。',
                repair: '请改填更完整的入口路径，至少包含页面目录或 Action 包路径，避免只填同名文件。'
            };
        }
        return {
            ok: false,
            code: 'REQUIREMENT_STORIES_SUBMIT_EXISTING_ADJUSTMENT_ENTRY_FILE_NOT_VERIFIED',
            message: '历史功能调整入口文件必须是真实存在的 HtmlPage/Action，或能从项目勘测结果唯一匹配到真实入口。',
            repair: '请填写真实存在的 HtmlPage/Action 入口；如果只知道页面名，先填用户已确认的页面名或入口线索，系统会在项目勘测结果唯一匹配时自动纠正。'
        };
    }

    _buildExistingEntryScanCatalog(projectPath = '') {
        const projectRoot = path.resolve(String(projectPath || '').trim());
        const catalog = { projectRoot, entries: [], routeEdges: [] };
        if (!projectRoot) return catalog;
        const scanDir = path.join(projectRoot, '.ai-workspace', 'project');
        const assetIndex = this._readJsonIfExists(path.join(scanDir, 'asset-index.json'));
        for (const item of (Array.isArray(assetIndex && assetIndex.assetIndex) ? assetIndex.assetIndex : [])) {
            const assetType = String(item && item.assetType || '').toLowerCase();
            const fileKind = assetType === 'htmlpage' ? 'HtmlPage'
                : assetType === 'action' ? 'Action'
                    : '';
            this._addScanEntry(catalog, fileKind, item && item.sourcePath, 'asset-index');
        }
        const reuseIndex = this._readJsonIfExists(path.join(scanDir, 'code-reuse-index.json'));
        for (const action of (Array.isArray(reuseIndex && reuseIndex.actions) ? reuseIndex.actions : [])) {
            this._addScanEntry(catalog, 'Action', action && action.sourcePath, 'code-reuse-index.actions');
        }
        const routeLike = []
            .concat(Array.isArray(reuseIndex && reuseIndex.routeEdges) ? reuseIndex.routeEdges : [])
            .concat(Array.isArray(reuseIndex && reuseIndex.actionMethodSlices) ? reuseIndex.actionMethodSlices : []);
        for (const route of routeLike) {
            const htmlRel = this._addScanEntry(catalog, 'HtmlPage', route && route.htmlPage, 'code-reuse-index.route');
            const actionRel = this._addScanEntry(catalog, 'Action', route && route.actionPath, 'code-reuse-index.route');
            if (htmlRel && actionRel) {
                catalog.routeEdges.push({ htmlRel, actionRel });
            }
        }
        return catalog;
    }

    _readJsonIfExists(filePath) {
        try {
            if (!filePath || !fs.existsSync(filePath)) return null;
            return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch (_) {
            return null;
        }
    }

    _addScanEntry(catalog, fileKind, sourcePath, source) {
        if (!catalog || !ALLOWED_EXISTING_ENTRY_FILE_KINDS.has(fileKind)) return '';
        const relativePath = this._normalizeScanRelativePath(catalog.projectRoot, sourcePath);
        if (!relativePath) return '';
        const resolvedPath = path.resolve(catalog.projectRoot, relativePath);
        const key = `${fileKind}::${relativePath}`;
        if (!catalog.entries.some(item => `${item.fileKind}::${item.relativePath}` === key)) {
            catalog.entries.push({ fileKind, relativePath, path: resolvedPath, source });
        }
        return relativePath;
    }

    _normalizeScanRelativePath(projectRoot, sourcePath) {
        const raw = String(sourcePath || '').trim();
        if (!raw || raw.indexOf('\0') !== -1) return '';
        const normalizedRaw = this._normalizeRelativePath(raw);
        const resolved = path.isAbsolute(raw)
            ? path.resolve(raw)
            : path.resolve(projectRoot, normalizedRaw);
        const relative = path.relative(projectRoot, resolved);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return '';
        return this._normalizeRelativePath(relative);
    }

    _normalizeRelativePath(value) {
        return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
    }

    _findScanEntryMatches(fileKind, rawPath, resolvedPath, projectPath, scanCatalog) {
        if (!scanCatalog || !Array.isArray(scanCatalog.entries)) return [];
        const projectRoot = path.resolve(String(projectPath || '').trim());
        const rawRelative = this._normalizeRelativePath(path.relative(projectRoot, resolvedPath || ''));
        const rawText = this._normalizeRelativePath(rawPath);
        const rawBase = path.posix.basename(rawRelative || rawText).toLowerCase();
        const candidates = scanCatalog.entries.filter(item => item.fileKind === fileKind);
        return candidates.filter(item => {
            const entryRel = String(item.relativePath || '').toLowerCase();
            const relative = rawRelative.toLowerCase();
            const text = rawText.toLowerCase();
            return (relative && (entryRel === relative || entryRel.endsWith(`/${relative}`) || relative.endsWith(`/${entryRel}`)))
                || (text && (entryRel === text || entryRel.endsWith(`/${text}`) || text.endsWith(`/${entryRel}`)))
                || (rawBase && path.posix.basename(entryRel) === rawBase);
        });
    }

    _routeActionEntriesForHtml(htmlRelativePath, scanCatalog) {
        if (!scanCatalog || !Array.isArray(scanCatalog.routeEdges)) return [];
        const htmlRel = this._normalizeRelativePath(htmlRelativePath).toLowerCase();
        const actionRels = new Set(scanCatalog.routeEdges
            .filter(edge => String(edge && edge.htmlRel || '').toLowerCase() === htmlRel)
            .map(edge => String(edge && edge.actionRel || '').trim())
            .filter(Boolean));
        const out = [];
        for (const actionRel of actionRels) {
            const entry = scanCatalog.entries.find(item =>
                item.fileKind === 'Action'
                && String(item.relativePath || '').toLowerCase() === actionRel.toLowerCase());
            const resolvedPath = entry ? entry.path : path.resolve(scanCatalog.projectRoot, actionRel);
            if (!fs.existsSync(resolvedPath)) continue;
            out.push({
                fileKind: 'Action',
                path: resolvedPath,
                source: 'scan_route_edge',
                verificationStatus: 'verified'
            });
        }
        return out;
    }

    _blocked(errorCode, message, context = {}) {
        const projectPath = String(context && context.projectPath || '').trim();
        const isStoriesArgForbidden = errorCode === 'REQUIREMENT_STORIES_SUBMIT_STORIES_ARG_FORBIDDEN';
        const isAnalysisStateJsonInvalid = errorCode === 'REQUIREMENT_STORIES_SUBMIT_ANALYSIS_STATE_JSON_INVALID';
        const isStoriesRootEmpty = errorCode === 'REQUIREMENT_STORIES_SUBMIT_ANALYSIS_STATE_STORIES_EMPTY';
        // 给所有 blocked 都带正确 callTemplate 骨架,让 LLM 修完 analysis-state 后能直接重调。
        // 单源空白写作骨架,与 issues 分支共用 MINIMAL_STORY_EXAMPLE 常量。
        const instruction = isAnalysisStateJsonInvalid
            ? 'analysis-state.json 当前不是合法 JSON。先只修 JSON 语法（常见是对象/数组末尾多逗号、括号不闭合、字符串未转义），不要改写 stories.json；JSON 可解析后再按 callTemplate 重调 req_stories_submit。'
            : isStoriesRootEmpty
            ? '只修 Builder 已创建的 analysis-state.json.stories：在现有 stories 对象内新增 stories.US1 / stories.US2，并把 acceptanceCriteria 与 invariants 放在各自 Story 内；禁止自创 step2_stories、step3_acceptanceCriteria、step4_invariants，也不要返回 Step 5 重答已确认业务。'
            : isStoriesArgForbidden
            ? 'req_stories_submit 不接收 stories 入参。Story 业务事实只落在 analysis-state.json.stories；先把全部 Story 缺项一次性修完后按 callTemplate 重调。'
            : '请只修 analysis-state.json.stories 中的 Story 业务事实：acceptanceCriteria 必须是 object；happyPath/exception/boundary 必须是数组；每条 GWT 必须含 scenario/given/when/then；invariants 必须是数组。先汇总全部缺项并一次性修完后，再按 callTemplate 重调 req_stories_submit；禁止修一条就重调。';
        return {
            ok: false,
            status: 'blocked',
            actionMode: 'repair_requirement_stories_input',
            source: 'requirement_stories_builder',
            errorCode,
            message,
            ...(Array.isArray(context && context.issues) ? { issues: context.issues } : {}),
            ...(context && context.hint ? { hint: context.hint } : {}),
            nextActionCard: context && context.nextActionCard ? context.nextActionCard : {
                title: '修复 analysis-state.json.stories 后重调 req_stories_submit',
                stopAfter: false,
                instruction,
                issueRepairBatchPolicy: {
                    mustReviewAllIssues: true,
                    repairTarget: 'analysis-state.json.stories',
                    rerunOnlyAfterAllIssuesFixed: true,
                    forbidden: ['rerun_after_single_issue_fix', 'write_stories_json_directly', 'pass_stories_arg_to_req_stories_submit']
                },
                minimalExample: MINIMAL_STORY_EXAMPLE,
                ...(!isStoriesArgForbidden ? { authoringContract: AUTHORING_CONTRACT } : {}),
                callTemplate: _buildFocusedStructureCallTemplate(projectPath)
            },
            allowedNextActions: ['rerun_req_stories_submit_after_repair'],
            forbiddenActions: ['write_stories_json_directly', 'pass_stories_arg_to_req_stories_submit']
        };
    }
}

RequirementStoriesBuilderService.SCHEMA_VERSION = SCHEMA_VERSION;
RequirementStoriesBuilderService.MANAGED_BY = MANAGED_BY;
RequirementStoriesBuilderService.MINIMAL_STORY_EXAMPLE = MINIMAL_STORY_EXAMPLE;
RequirementStoriesBuilderService.AUTHORING_CONTRACT = AUTHORING_CONTRACT;
RequirementStoriesBuilderService.PREPARE_AUTHORING_CONTRACT = PREPARE_AUTHORING_CONTRACT;
RequirementStoriesBuilderService.OPTIONAL_EXISTING_CARRIER_EXAMPLE = OPTIONAL_EXISTING_CARRIER_EXAMPLE;
RequirementStoriesBuilderService.DELIVERY_BOUNDARY_GUIDE = DELIVERY_BOUNDARY_GUIDE;
RequirementStoriesBuilderService.CODING_FACT_HANDOFF_GUIDE = CODING_FACT_HANDOFF_GUIDE;
RequirementStoriesBuilderService.STATISTICS_INTENT_GUIDE = STATISTICS_INTENT_GUIDE;
RequirementStoriesBuilderService.WORKFLOW_INTENT_GUIDE = WORKFLOW_INTENT_GUIDE;
RequirementStoriesBuilderService.EXISTING_ENTRY_FACT_REQUIRED_NOTE = EXISTING_ENTRY_FACT_REQUIRED_NOTE;

module.exports = RequirementStoriesBuilderService;
