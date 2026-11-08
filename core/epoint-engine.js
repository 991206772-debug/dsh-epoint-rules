#!/usr/bin/env node

let Server, StdioServerTransport, CallToolRequestSchema, ListToolsRequestSchema;
try {
  Server = require("@modelcontextprotocol/sdk/server/index.js").Server;
  StdioServerTransport = require("@modelcontextprotocol/sdk/server/stdio.js").StdioServerTransport;
  const types = require("@modelcontextprotocol/sdk/types.js");
  CallToolRequestSchema = types.CallToolRequestSchema;
  ListToolsRequestSchema = types.ListToolsRequestSchema;
} catch {
  // DSH 原生运行时环境下直接执行，无需外部 @modelcontextprotocol/sdk 依赖
  Server = class MockServer {
    setRequestHandler() {}
    connect() {}
  };
  StdioServerTransport = class MockTransport {};
  CallToolRequestSchema = {};
  ListToolsRequestSchema = {};
}

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// 导入业务模块
const RuleService = require('./modules/rule-service');
const TeamRulesService = require('./modules/team-rules-service');
const RecommendationService = require('./modules/recommendation-service');
const AIAgent = require('./modules/ai-agent');
const SkillIntentService = require('./modules/skill-intent');
const ProjectScanService = require('./modules/project-scan-service');
const LocalizationExpert = require('./modules/localization-expert');
const PromptEnhancer = require('./modules/prompt-enhancer');
const PipelineUtils = require('./modules/pipeline-utils');
const SkillRuntimeToolGuardService = require('./modules/pipeline-support/skill-runtime-tool-guard-service');
const GateContractRegistry = require('./modules/pipeline-support/gate-contract-registry');
const DesignTddContextService = require('./modules/pipeline-support/design-tdd-context-service');
const DesignTddPlanService = require('./modules/pipeline-support/design-tdd-plan-service');
const DesignTddDataAccessPlanService = require('./modules/pipeline-support/design-tdd-data-access-plan-service');
const DesignTddSkeletonService = require('./modules/pipeline-support/design-tdd-skeleton-service');
const CoderReuseCardService = require('./modules/pipeline-support/coder-reuse-card-service');
const DesignTddCodeRuntimeService = require('./modules/pipeline-support/design-tdd-code-runtime-service');
const DesignTddActionClosureValidator = require('./modules/pipeline-support/design-tdd-action-closure-validator');
const SkeletonManifestArchiveService = require('./modules/pipeline-support/skeleton-manifest-archive-service');
const DesignTddProgressBoardService = require('./modules/pipeline-support/design-tdd-progress-board-service');
const DesignCodingHandoffService = require('./modules/pipeline-support/design-coding-handoff-service');
const DesignSchemaValidatorService = require('./modules/pipeline-support/design-schema-validator-service');
const DesignDatabaseNamingValidatorService = require('./modules/pipeline-support/design-database-naming-validator-service');
const DesignRuleBindingValidatorService = require('./modules/pipeline-support/design-rule-binding-validator-service');
const DesignTddGeneratedArtifactsService = require('./modules/pipeline-support/design-tdd-generated-artifacts-service');
const DesignWorkflowArtifactService = require('./modules/pipeline-support/design-workflow-artifact-service');
const DesignTddDeliveryDocumentationService = require('./modules/pipeline-support/design-tdd-delivery-documentation-service');
const DesignTddSqlDslService = require('./modules/pipeline-support/design-tdd-sql-dsl-service');
const ProjectionTransactionService = require('./modules/pipeline-support/design-tdd-projection-transaction-service');
const { DESIGN_MANAGED_RUNTIME_ACTION_SET } = require('./modules/pipeline-support/design-managed-runtime-actions');
const ManagedArtifactFinalizerService = require('./modules/pipeline-support/managed-artifact-finalizer-service');
const { removeFiles: removeTemporaryFiles, removeEmpty: removeEmptyTemporaryDirectory, assertSafe: assertTemporaryPathSafe } = require('./modules/pipeline-support/stage-temporary-cleanup-service');
const RequirementRulePoolService = require('./modules/pipeline-support/requirement-rule-pool-service');
const RequirementRulePoolBuilderService = require('./modules/pipeline-support/requirement-rule-pool-builder-service');
const RequirementStoriesBuilderService = require('./modules/pipeline-support/requirement-stories-builder-service');
const RequirementAnalysisMarkdownRendererService = require('./modules/pipeline-support/requirement-analysis-markdown-renderer-service');
const {
  decisionRowsSchema,
  detailRowsSchema,
  compositionRowsSchema
} = require('./modules/pipeline-support/design-decision-step-definition');
const DesignWorkflowService = require('./modules/pipeline-support/design-workflow-service');
const FeedbackContract = require('./modules/pipeline-support/stage-feedback-contract');
const DesignCoderConstructionCoverageService = require('./modules/pipeline-support/design-coder-construction-coverage-service');
const RUNTIME_USER_REPLY_ARG_KEY = '__runtimeUserReply';
const RUNTIME_REFERENCE_READ_ARG_KEY = '__r2cRuntimeReferenceRead';
const MAX_CONTINUATION_RESPONSE_BYTES = 32 * 1024;
let StandaloneMonitorService, StandaloneMonitorServer;
try {
  const monitorModule = require('./modules/monitor-server');
  StandaloneMonitorService = monitorModule.StandaloneMonitorService;
  StandaloneMonitorServer = monitorModule.StandaloneMonitorServer;
} catch {
  // monitor-server 在 DSH 原生插件环境中为可选
}

// 部分 MCP 客户端/Agent 会只把 tools/list 的前 N 个工具注入给模型。
// 当前三段主线 Skill 深度依赖的 MCP 必须排在前面，避免客户端只注入 tools/list
// 前 N 个工具时，LLM 看不到 project_scan / mark_acceptance / reuse refresh 等入口。
const MAINLINE_MCP_TOOL_PRIORITY = [
  'project_scan',
  'req_prepare_context',
  'req_stories_submit',
  'req_rule_pool_build_rule_draft',
  'req_rule_decision_submit',
  'req_rule_pool_build_table_draft',
  'req_table_decision_submit',
  'req_finalize_artifacts',
  'design_prepare_context',
  'design_tdd_build_plan',
  'design_tdd_skeleton_materialize',
  'rule_expert',
  'scan_reuse_index_refresh'
];

const MAINLINE_MCP_TOOL_PRIORITY_INDEX = new Map(
  MAINLINE_MCP_TOOL_PRIORITY.map((name, index) => [name, index])
);

const DESIGN_TDD_CODER_PUBLIC_TOOL_NAMES = new Set([
  'design_tdd_build_plan',
  'design_tdd_skeleton_materialize'
]);

function isUsableTeamRulesRepo(repoPath) {
  if (!repoPath || !fs.existsSync(repoPath)) return false;
  const candidates = [
    path.join(repoPath, 'knowledge.sqlite'),
    path.join(repoPath, '.index', 'knowledge.base.sqlite'),
    path.join(repoPath, 'knowledge.base.sqlite'),
    path.join(repoPath, 'index.json'),
  ];
  return candidates.some((candidate) => fs.existsSync(candidate));
}

const STATEFUL_MCP_TOOLS_REQUIRING_SKILL_NAME = new Set([
  'rule_expert',
  'design_prepare_context',
  'req_finalize_artifacts',
  'requirement_analyzer_finalize_artifacts',
  'req_rule_pool_build_rule_draft',
  'req_rule_decision_submit',
  'req_rule_pool_build_table_draft',
  'req_table_decision_submit',
  'req_stories_submit'
]);

class EpointRulesMCPServer {
  constructor() {
    this._startStandaloneMonitorIfNeeded();

    // 优先使用插件显式传入的工作区根；外部 MCP 客户端未传时再回退到启动 cwd。
    this.workspaceRoot = process.env.EPOINT_WORKSPACE_ROOT || process.cwd();

    // 初始化路径
    this.rulesPath = process.env.EPOINT_RULES_PATH || path.join(__dirname, '../projectrules');
    this.userRulesPath = process.env.EPOINT_USER_RULES_PATH || null;

    // 初始化服务
    this.ruleService = new RuleService(
      this.rulesPath,
      this.userRulesPath,
      process.env.RULES_REPO_PATH,
      process.env.RULES_GIT_BRANCH,
      process.env.SKILL_HUB_REPO_PATH
    );

    // 团队规则索引检索（B 方案）：搜索从本地 KNOWLEDGE_REPO_PATH 读 knowledge.sqlite 做 SQLite FTS；
    // 全文 getRule 在线拉 GitLab raw URL（KNOWLEDGE_GIT_URL），不依赖本地 .md。
    // 索引由管理员用 knowledge-inbox build-sqlite/publish 推到团队知识库 GitLab 仓库。
    // 使用者侧由插件 rulesGitSync 把 knowledge.sqlite sparse-checkout 到 {rulesPath}/.knowledge_repo。
    // 兼容回退：旧版本一直把索引放在项目规范仓库的 .project_repo 根，这里仍读 RULES_REPO_PATH 兜底。
    const userRulesCandidate = isUsableTeamRulesRepo(this.userRulesPath) ? this.userRulesPath : '';
    const knowledgeRepoCandidate = this.rulesPath ? require('path').join(this.rulesPath, '.knowledge_repo') : '';
    const legacyProjectRepoCandidate = this.rulesPath ? require('path').join(this.rulesPath, '.project_repo') : '';
    const envKnowledgeRepoCandidate = process.env.KNOWLEDGE_REPO_PATH || '';
    const envRulesRepoCandidate = process.env.RULES_REPO_PATH || '';
    const teamRulesRepoPath = userRulesCandidate ||
      (isUsableTeamRulesRepo(envKnowledgeRepoCandidate) ? envKnowledgeRepoCandidate : '') ||
      (isUsableTeamRulesRepo(knowledgeRepoCandidate) ? knowledgeRepoCandidate : '') ||
      (isUsableTeamRulesRepo(envRulesRepoCandidate) ? envRulesRepoCandidate : '') ||
      (isUsableTeamRulesRepo(legacyProjectRepoCandidate) ? legacyProjectRepoCandidate : '');
    this.teamRulesService = teamRulesRepoPath
      ? new TeamRulesService(teamRulesRepoPath, {
          remoteBaseUrl: process.env.KNOWLEDGE_GIT_URL || '',
          remoteBranch: process.env.KNOWLEDGE_GIT_BRANCH || 'main',
          remoteToken: process.env.KNOWLEDGE_GIT_TOKEN || ''
        })
      : null;
    this.recommendationService = new RecommendationService(this.ruleService);
    this.skillIntentService = new SkillIntentService(this.ruleService);
    this.aiAgent = new AIAgent(this.ruleService, this.skillIntentService);
    this.projectScanService = new ProjectScanService(this.ruleService);
    // 初始化国产化适配专家
    this.localizationExpert = new LocalizationExpert(this.ruleService);
    this.gateContractRegistry = GateContractRegistry.getInstance();
    this.designTddCodeRuntimeService = new DesignTddCodeRuntimeService();
    this.designTddSkeletonService = new DesignTddSkeletonService({
      ruleService: this.ruleService,
      rulesPath: this.rulesPath
    });
    this.designTddContextService = new DesignTddContextService({
      codeRuntimeService: this.designTddCodeRuntimeService,
      workProjectionService: this.designTddSkeletonService,
      navigationContractService: this.projectScanService.navigationContractService
    });
    this.projectionTransactionService = new ProjectionTransactionService();
    this.coderReuseCardService = new CoderReuseCardService();
    this.designTddDataAccessPlanService = new DesignTddDataAccessPlanService({
      refreshReuseIndex: projectPath => this.coderReuseCardService.refreshIndex({
        projectPath,
        scriptPath: this._resolveReuseIndexScriptPath()
      })
    });
    this.designTddPlanService = new DesignTddPlanService({
      contextService: this.designTddContextService,
      ruleService: this.ruleService,
      codeRuntimeService: this.designTddCodeRuntimeService,
      workProjectionService: this.designTddSkeletonService,
      dataAccessPlanService: this.designTddDataAccessPlanService
    });
    this.designCodingHandoffService = new DesignCodingHandoffService();
    this.designSchemaValidatorService = new DesignSchemaValidatorService();
    this.designDatabaseNamingValidatorService = new DesignDatabaseNamingValidatorService();
    this.designRuleBindingValidatorService = new DesignRuleBindingValidatorService();
    const DesignDocumentBuilderService = require('./modules/pipeline-support/design-document-builder-service');
    this.designDocumentBuilderService = new DesignDocumentBuilderService();
    this.requirementRulePoolService = new RequirementRulePoolService();
    this.requirementRulePoolBuilderService = new RequirementRulePoolBuilderService({
      skillIntentService: this.skillIntentService,
      requirementRulePoolService: this.requirementRulePoolService
    });
    this.requirementStoriesBuilderService = new RequirementStoriesBuilderService();
    this.requirementAnalysisMarkdownRendererService = new RequirementAnalysisMarkdownRendererService();
    this.managedArtifactFinalizerService = new ManagedArtifactFinalizerService();
    this.designCoderConstructionCoverageService = new DesignCoderConstructionCoverageService();
    this.designWorkflowService = new DesignWorkflowService({
      finalize: async input => this._finalizeCanonicalDesignWorkflow(input)
    });
    this.designTddActionClosureValidator = new DesignTddActionClosureValidator();
    this.designTddGeneratedArtifactsService = new DesignTddGeneratedArtifactsService();
    this.designWorkflowArtifactService = new DesignWorkflowArtifactService();
    this.skillRuntimeToolGuardService = new SkillRuntimeToolGuardService({ workspaceRoot: this.workspaceRoot });
    this.designTddDeliveryDocumentationService = new DesignTddDeliveryDocumentationService({
      deliverySummaryTemplatePath: path.join(
        this.skillRuntimeToolGuardService.designTddCoderSkillRoot,
        'assets',
        'delivery-summary-template.md'
      ),
      templatePath: path.join(
        this.skillRuntimeToolGuardService.designTddCoderSkillRoot,
        'assets',
        'interface-document-template.md'
      )
    });
    this.designTddSqlDslService = new DesignTddSqlDslService();

    // 创建 MCP Server
    this.server = new Server(
      {
        name: "epoint-project-rules-mcp",
        version: "1.1.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
    this.setupErrorHandling();
  }

  _startStandaloneMonitorIfNeeded() {
    if (!StandaloneMonitorService || !StandaloneMonitorServer) return;
    if (process.env.MONITOR_INGEST_URL) return;
    const configuredPort = Number(process.env.MONITOR_PORT || 3847);
    const monitorPort = Number.isFinite(configuredPort) && configuredPort > 0 ? configuredPort : 3847;
    process.env.MONITOR_INGEST_URL = `http://127.0.0.1:${monitorPort}/api/ingest`;
    try {
      const service = new StandaloneMonitorService(process.env.MONITOR_STATE_DIR || '');
      const server = new StandaloneMonitorServer(service, monitorPort);
      this.standaloneMonitorServer = server;
      server.start().then(started => {
        if (!started) {
          console.error(`[Monitor] MCP standalone monitor not available on port ${monitorPort}.`);
        }
      });
    } catch (error) {
      console.error(`[Monitor] Failed to initialize MCP standalone monitor: ${error.message}`);
    }
  }

  _toComparableProjectPath(projectPath) {
    const resolved = path.resolve(projectPath || '');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  _resolveReuseIndexScriptPath() {
    const candidates = [
      path.resolve(__dirname, 'scripts', 'generate_baseline_report.py'),
      path.resolve(__dirname, '..', 'mcp_tools', 'scripts', 'generate_baseline_report.py'),
      path.resolve(process.cwd(), 'mcp_tools', 'scripts', 'generate_baseline_report.py')
    ];
    return candidates.find(candidate => fs.existsSync(candidate))
      || candidates[candidates.length - 1];
  }

  _formatIntentDiagnostics(intentResult = null) {
    const diagnostics = intentResult
      && intentResult._structured
      && intentResult._structured.diagnostics
      && typeof intentResult._structured.diagnostics === 'object'
      ? intentResult._structured.diagnostics
      : null;
    if (!diagnostics) return '';

    const lines = [];
    lines.push('');
    lines.push('---');
    lines.push('诊断摘要（用于规则命中解释）');
    lines.push(`- 评分核心：${String(diagnostics.scoringEngine || '').trim() || 'unknown'}`);
    lines.push(`- 命中数量：${Number(diagnostics.matchCount || 0)}`);
    const topMatches = Array.isArray(diagnostics.topMatches) ? diagnostics.topMatches : [];
    topMatches.slice(0, 3).forEach((item, index) => {
      const alias = String(item && item.ruleAlias || '').trim() || `match_${index + 1}`;
      const keywords = Array.isArray(item && item.matchedKeywords) ? item.matchedKeywords.filter(Boolean) : [];
      lines.push(`- Top${index + 1}：${alias}（weight=${Number(item && item.weight || 0)}，lane=${String(item && item.matchLane || '').trim() || 'default'}，命中词=${keywords.join('、') || '无'}）`);
    });
    return lines.join('\n');
  }

  _slimSkeletonMaterializeResult(result = {}) {
    const materializedFiles = Array.isArray(result.materializedFiles) ? result.materializedFiles : [];
    return {
      ok: result.ok === true,
      status: result.status || (result.ok === true ? 'materialized' : 'blocked'),
      errors: Array.isArray(result.errors) ? result.errors : [],
      input: result.inputPath ? { written: true, path: result.inputPath } : null,
      manifest: result.manifestPath ? { written: true, path: result.manifestPath } : null,
      materializedFiles: materializedFiles.map(file => ({
        targetFile: file.targetFile || file.filePath || '',
        fileKind: file.fileKind || '',
        status: file.status || '',
        methodNames: Array.isArray(file.methodNames) ? file.methodNames : [],
        methodSignatures: Array.isArray(file.methodSignatures) ? file.methodSignatures : []
      }))
    };
  }

  _formatRequirementRuleAnalyzeResult(result = null, options = {}) {
    if (!result || typeof result !== 'object') return '';
    const acceptedRules = Array.isArray(result.acceptedRules) ? result.acceptedRules : [];
    const baselineConstraints = Array.isArray(result.baselineConstraints) ? result.baselineConstraints : [];
    const projectTableCandidates = Array.isArray(result.projectTableCandidates) ? result.projectTableCandidates : [];
    const unresolvedSignals = Array.isArray(result.unresolvedSignals) ? result.unresolvedSignals : [];
    const diagnostics = result.diagnostics && typeof result.diagnostics === 'object'
      ? {
          scoringEngine: result.diagnostics.scoringEngine || 'pure_like_recall_v1',
          stage: result.diagnostics.stage || 'requirement',
          matchCount: Number(result.diagnostics.matchCount || (acceptedRules.length + baselineConstraints.length)),
          strategy: result.diagnostics.strategy || ''
        }
      : null;
    const slimAcceptedRules = acceptedRules.map(rule => {
      const slim = { ...rule };
      // matchedTerms 与 matchedKeywords 同义，输出时仅保留 matchedKeywords，避免 LLM 看双份
      if (Array.isArray(slim.matchedKeywords) && Array.isArray(slim.matchedTerms)
          && slim.matchedKeywords.length === slim.matchedTerms.length
          && slim.matchedKeywords.every((kw, idx) => kw === slim.matchedTerms[idx])) {
        delete slim.matchedTerms;
      }
      return slim;
    });
    const slimBaselineConstraints = baselineConstraints.map(rule => {
      const slim = { ...rule };
      if (Array.isArray(slim.matchedKeywords) && slim.matchedKeywords.length === 0) {
        delete slim.matchedTerms;
      } else if (Array.isArray(slim.matchedKeywords) && Array.isArray(slim.matchedTerms)
          && slim.matchedKeywords.length === slim.matchedTerms.length
          && slim.matchedKeywords.every((kw, idx) => kw === slim.matchedTerms[idx])) {
        delete slim.matchedTerms;
      }
      return slim;
    });
    const lines = [];
    lines.push('');
    lines.push('---');
    lines.push('## 需求规则召回结果（纯 LIKE，多召回交由用户在 Step 3.5 剔除卡收口）');
    if (baselineConstraints.length > 0) {
      lines.push(`- 基础约束：${baselineConstraints.length} 条（不进入用户规则池，不进入模块绑定，仅供 Builder/Coder 审计消费）`);
      baselineConstraints.slice(0, 8).forEach((rule, index) => {
        const alias = String(rule && (rule.ruleAlias || rule.ruleName) || '').trim() || `BASELINE-${index + 1}`;
        const type = String(rule && rule.constraintType || '').trim() || 'baseline_constraint';
        const reason = String(rule && rule.reasonCode || '').trim() || 'baseline';
        lines.push(`  ${index + 1}. ${alias}｜type=${type}｜reason=${reason}`);
      });
    }
    else {
      lines.push('- 基础约束：0 条');
    }
    if (acceptedRules.length > 0) {
      lines.push(`- 业务可选规则：${acceptedRules.length} 条（命中数排序，由用户在 Step 3.5 剔除卡决定保留/剔除）`);
      acceptedRules.slice(0, 12).forEach((rule, index) => {
        const alias = String(rule && (rule.ruleAlias || rule.ruleName) || '').trim() || `RULE-${index + 1}`;
        const hits = Array.isArray(rule && rule.matchedKeywords) ? rule.matchedKeywords : [];
        const hitText = hits.length > 0 ? hits.slice(0, 6).join(' / ') : '（基础注入）';
        lines.push(`  ${index + 1}. ${alias}｜命中关键词：${hitText}`);
      });
    }
    else {
      lines.push('- 业务可选规则：0 条');
    }
    if (projectTableCandidates.length > 0) {
      lines.push(`- 项目表候选：${projectTableCandidates.length} 项（来自 scan entity-graph，仅作上下文候选，不作为硬规则）`);
      projectTableCandidates.slice(0, 8).forEach((item, index) => {
        const tableName = String(item && item.tableName || '').trim() || '-';
        const entityName = String(item && item.entityName || '').trim() || '-';
        const displayName = String(item && item.tableDisplayName || '').trim() || '未记录';
        const matchedTerms = Array.isArray(item && item.matchedTerms) ? item.matchedTerms.filter(Boolean).slice(0, 4).join('、') : '';
        lines.push(`  ${index + 1}. ${tableName}｜entity=${entityName}｜${displayName}${matchedTerms ? `｜命中=${matchedTerms}` : ''}`);
      });
    }
    else {
      lines.push('- 项目表候选：0 项');
    }
    if (unresolvedSignals.length > 0) {
      lines.push(`- 未解析信号：${unresolvedSignals.length} 项`);
      unresolvedSignals.slice(0, 8).forEach((item, index) => {
        const signal = String(item && item.signal || '').trim() || `signal_${index + 1}`;
        const anchor = String(item && item.userAnchor || '').trim() || '未记录';
        lines.push(`  ${index + 1}. ${signal}｜anchor=${anchor}`);
      });
      lines.push('- 下一步口径：未解析信号仅作规则召回提示；未解析信号只能转 questionCard/blocker 由当前需求流程收口，不阻断后续流程；禁止通过搜索项目源码、表结构或类似实现补证据，也不得冒名成已确认规则。');
    }
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify({
      acceptedRules: slimAcceptedRules,
      baselineConstraints: slimBaselineConstraints,
      projectTableCandidates,
      unresolvedSignals,
      diagnostics
    }, null, 2));
    lines.push('```');
    return lines.join('\n');
  }

  _sha256(value = '') {
    return `sha256:${crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex')}`;
  }

  _slug(value = 'artifact') {
    const slug = String(value || 'artifact')
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80);
    return slug || 'artifact';
  }

  _ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  _isSameOrChildPath(child, parent) {
    const resolvedChild = path.resolve(String(child || ''));
    const resolvedParent = path.resolve(String(parent || ''));
    const childKey = process.platform === 'win32' ? resolvedChild.toLowerCase() : resolvedChild;
    const parentKey = process.platform === 'win32' ? resolvedParent.toLowerCase() : resolvedParent;
    return childKey === parentKey || childKey.startsWith(parentKey + path.sep);
  }

  _isValidDemandName(demandName) {
    const value = String(demandName || '').trim();
    return Boolean(value) &&
      value !== '.' &&
      value !== '..' &&
      !path.isAbsolute(value) &&
      !value.includes('/') &&
      !value.includes('\\');
  }

  _ensureDemandNameWithDatePrefix(demandName) {
    // demandName 命名规范：`<yyyy-MM-dd>_<需求名称>`。
    // 日期前缀是 Builder 可派生的确定事实——LLM 只传业务名时由 Builder 自动补齐当天日期；
    // LLM 已带合法日期前缀（`yyyy-MM-dd_*`）则原样保留，不重复包装。
    const value = String(demandName || '').trim();
    if (!value) return value;
    if (/^\d{4}-\d{2}-\d{2}_/.test(value)) return value;
    const today = new Date();
    const yyyy = String(today.getFullYear());
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}_${value}`;
  }

  _readJsonIfExists(filePath) {
    if (!fs.existsSync(filePath)) return { ok: false, exists: false, value: null };
    try {
      return { ok: true, exists: true, value: JSON.parse(fs.readFileSync(filePath, 'utf-8')) };
    } catch (error) {
      return { ok: false, exists: true, value: null, error };
    }
  }

  _readManagedFinalizeReceipt(receiptPath, expectedStageKey = '') {
    const resolved = path.resolve(String(receiptPath || '').trim());
    if (!resolved || !fs.existsSync(resolved)) {
      return { ok: false, exists: false, path: resolved };
    }
    try {
      const receipt = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
      const schemaOk = String(receipt && receipt.schemaVersion || '') === 'managed-artifact-finalizer/v1';
      const ok = receipt && receipt.ok === true && String(receipt.status || '') === 'ready';
      const stageKey = String(receipt && receipt.stageKey || '').trim();
      const stageOk = !expectedStageKey || stageKey === expectedStageKey;
      return {
        ok: Boolean(schemaOk && ok && stageOk),
        exists: true,
        path: resolved,
        stageKey,
        generatedAt: String(receipt && receipt.generatedAt || '').trim()
      };
    } catch (error) {
      return { ok: false, exists: true, path: resolved, error: String(error && error.message || error) };
    }
  }

  _resolveDemandClosureState(projectArtifactsDir, demandName) {
    const demandDir = path.resolve(projectArtifactsDir, String(demandName || '').trim());
    const requirementReceipt = this._readManagedFinalizeReceipt(
      path.join(demandDir, 'demand', 'requirement-finalize-receipt.json'),
      'requirement-analyzer'
    );
    const designReceipt = this._readManagedFinalizeReceipt(
      path.join(demandDir, 'design', 'design-finalize-receipt.json'),
      'requirement-design'
    );
    const primaryReceipt = designReceipt.ok
      ? designReceipt
      : (requirementReceipt.ok ? requirementReceipt : null);
    const closureLevel = designReceipt.ok
      ? 'design_finalized'
      : (requirementReceipt.ok ? 'requirement_finalized' : 'open');
    return {
      closed: Boolean(primaryReceipt),
      closureLevel,
      demandDir,
      receipts: {
        requirement: requirementReceipt,
        design: designReceipt
      },
      primaryReceipt
    };
  }

  _renderAndWriteRequirementAnalysisMarkdown(requirementPaths = {}, analysisState = {}) {
    this._ensureDir(requirementPaths.demandArtifactDir);
    const demandMarkdown = this.requirementAnalysisMarkdownRendererService.render(
      requirementPaths,
      analysisState || {}
    );
    fs.writeFileSync(requirementPaths.demandAnalysisPath, demandMarkdown, 'utf-8');
    return {
      ok: true,
      path: requirementPaths.demandAnalysisPath
    };
  }

  /**
   * Builder-owned 兼容读取：从旧 analysis-state.json 的已确认补充中提取决策文本，
   * 合并到 userIntent 用于规则关键词检索。新需求不创建 ambiguity 卡片；
   * 这里保留读取只是为了让历史需求的既有业务补充不丢失。
   */
  _enrichUserIntentWithConfirmedDecisions(projectPath, userIntent) {
    try {
      const normalizedProject = path.resolve(String(projectPath || '').trim());
      const projectArtifactsDir = path.join(normalizedProject, '.ai-workspace', 'project');
      const activeDemandPath = path.join(projectArtifactsDir, '.active-demand');
      if (!fs.existsSync(activeDemandPath)) return userIntent;
      const demandName = String(fs.readFileSync(activeDemandPath, 'utf-8') || '').trim();
      if (!demandName) return userIntent;
      const statePath = path.join(projectArtifactsDir, demandName, 'demand', 'analysis-state.json');
      if (!fs.existsSync(statePath)) return userIntent;
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      const confirmedDecisions = [];
      const visit = (value, options = {}) => {
        if (!value) return;
        if (Array.isArray(value)) {
          value.forEach(item => visit(item, options));
          return;
        }
        if (typeof value !== 'object') return;
        const status = String(value.status || value.confirmStatus || '').trim().toLowerCase();
        if (options.ambiguityPoint === true && status && !['confirmed', 'done', 'completed', '已确认', '已完成'].includes(status)) {
          return;
        }
        const text = [
          String(value.fuzzyPoint || value.question || value.title || value.aspect || '').trim(),
          String(value.userChoice || value.choice || value.selectedOption || '').trim(),
          [
            String(value.businessDecision || value.businessDecisionSummary || value.businessConclusion || value.cleanBusinessDecision || '').trim(),
            String(value.flowImpact || value.businessFlowImpact || value.processImpact || '').trim()
          ].filter(Boolean).join('；')
            || String(value.adoptedSolution || value.solution || value.answer || value.confirmedAnswer || value.selectedAnswer || value.userAnswer || value.reason || value.userInput || '').trim()
        ].filter(Boolean).join('；');
        if (text) confirmedDecisions.push(text);
        if (Object.prototype.hasOwnProperty.call(value, 'decisions')) visit(value.decisions, options);
        if (Object.prototype.hasOwnProperty.call(value, 'decision')) visit(value.decision, options);
      };
      visit(state.ambiguityPoints, { ambiguityPoint: true });
      visit(state.decisions);
      visit(state.confirmedDecisions);
      visit(state.units);
      if (confirmedDecisions.length === 0) return userIntent;
      return `${userIntent}\n【已确认决策上下文】${Array.from(new Set(confirmedDecisions)).join('；')}`;
    } catch (_) {
      return userIntent;
    }
  }

  /**
   * Builder-owned: 自动累积 storyId 到 analysis-state.json.storyIds。
   * LLM 按 Story 调 rule_expert 时自动收集，不需要 LLM 额外写一步。
   */
  _accumulateStoryIdToState(projectPath, storyId) {
    try {
      const normalizedProject = path.resolve(String(projectPath || '').trim());
      const projectArtifactsDir = path.join(normalizedProject, '.ai-workspace', 'project');
      const activeDemandPath = path.join(projectArtifactsDir, '.active-demand');
      if (!fs.existsSync(activeDemandPath)) return;
      const demandName = String(fs.readFileSync(activeDemandPath, 'utf-8') || '').trim();
      if (!demandName) return;
      const statePath = path.join(projectArtifactsDir, demandName, 'demand', 'analysis-state.json');
      if (!fs.existsSync(statePath)) return;
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      const storyIds = Array.isArray(state.storyIds) ? state.storyIds : [];
      const normalized = String(storyId || '').trim().toUpperCase().replace(/^US[_-]?/i, 'US');
      if (!normalized) return;
      if (storyIds.some(id => String(id || '').trim().toUpperCase().replace(/^US[_-]?/i, 'US') === normalized)) return;
      storyIds.push(storyId);
      state.storyIds = storyIds;
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
    } catch (_) {
      // 累积失败不阻塞工具执行
    }
  }

  _resolveActiveDemandDesignPaths(projectPath) {
    const normalizedProject = path.resolve(String(projectPath || '').trim());
    const projectArtifactsDir = path.join(normalizedProject, '.ai-workspace', 'project');
    const activeDemandPath = path.join(projectArtifactsDir, '.active-demand');
    if (!fs.existsSync(activeDemandPath)) {
      return {
        ok: false,
        errorCode: 'DESIGN_PREFLIGHT_ACTIVE_DEMAND_MISSING',
        message: `缺少 .active-demand，无法将设计预检凭证绑定到具体需求目录：${activeDemandPath}`,
        activeDemandPath
      };
    }
    const demandName = String(fs.readFileSync(activeDemandPath, 'utf-8') || '').trim();
    if (!demandName) {
      return {
        ok: false,
        errorCode: 'DESIGN_PREFLIGHT_ACTIVE_DEMAND_EMPTY',
        message: `.active-demand 为空，无法将设计预检凭证绑定到具体需求目录：${activeDemandPath}`,
        activeDemandPath
      };
    }
    const demandDir = path.resolve(projectArtifactsDir, demandName);
    if (!this._isSameOrChildPath(demandDir, projectArtifactsDir)) {
      return {
        ok: false,
        errorCode: 'DESIGN_PREFLIGHT_DEMAND_DIR_OUT_OF_PROJECT',
        message: `.active-demand 指向非法需求目录：${demandName}`,
        activeDemandPath,
        demandName
      };
    }
    const designDir = path.join(demandDir, 'design');
    const deliveryRuntimeDir = path.join(demandDir, 'delivery', '.runtime');
    return {
      ok: true,
      projectArtifactsDir,
      activeDemandPath,
      demandName,
      demandDir,
      designDir,
      deliveryRuntimeDir,
      deliveryFactsPath: path.join(deliveryRuntimeDir, 'delivery-facts.json'),
      documentationTaskCardPath: path.join(deliveryRuntimeDir, 'documentation-task-card.json'),
      designJsonPath: path.join(designDir, '设计文档.json'),
      designMarkdownPath: path.join(designDir, '设计文档.md'),
      workflowArtifactsReceiptPath: path.join(designDir, 'workflow-artifacts-receipt.json'),
      workflowArtifactsRoot: path.join(designDir, 'generated-workflow'),
      ruleRecallRawPath: path.join(designDir, 'rule-recall-raw.md'),
      ruleBindingsPath: path.join(designDir, 'rule-bindings.json'),
      requirementRulePoolPath: path.join(demandDir, 'demand', 'rule-pool.json'),
      requirementAnalysisStatePath: path.join(demandDir, 'demand', 'analysis-state.json'),
      requirementStoriesPath: path.join(demandDir, 'demand', 'stories.json'),
      requirementStoriesReceiptPath: path.join(demandDir, 'demand', 'stories-submit-receipt.json'),
      demandAnalysisPath: path.join(demandDir, 'demand', '需求分析.md'),
      designStatePath: path.join(designDir, 'design-state.json'),
      receiptPath: path.join(designDir, 'design-preflight-receipt.json')
    };
  }

  _resolveActiveDemandRequirementPaths(projectPath, options = {}) {
    const normalizedProject = path.resolve(String(projectPath || '').trim());
    const projectArtifactsDir = path.join(normalizedProject, '.ai-workspace', 'project');
    const activeDemandPath = path.join(projectArtifactsDir, '.active-demand');

    const createActiveDemand = (rawDemandName, extra = {}) => {
      const raw = String(rawDemandName || '').trim();
      // 先校验原始输入合法性（不允许 . / .. / 含分隔符 / 绝对路径），通过后由 Builder 派生日期前缀
      if (!this._isValidDemandName(raw)) {
        return {
          ok: false,
          errorCode: 'REQUIREMENT_FINALIZE_DEMAND_NAME_INVALID',
          message: `需求名称非法：${raw}`,
          activeDemandPath,
          demandName: raw
        };
      }
      const demandName = this._ensureDemandNameWithDatePrefix(raw);
      const candidateDemandDir = path.resolve(projectArtifactsDir, demandName);
      if (!this._isSameOrChildPath(candidateDemandDir, projectArtifactsDir)) {
        return {
          ok: false,
          errorCode: 'REQUIREMENT_FINALIZE_DEMAND_DIR_OUT_OF_PROJECT',
          message: `.active-demand 将指向非法需求目录：${demandName}`,
          activeDemandPath,
          demandName
        };
      }
      this._ensureDir(projectArtifactsDir);
      fs.writeFileSync(activeDemandPath, demandName, 'utf-8');
      return {
        ok: true,
        demandName,
        ...extra
      };
    };

    if (!fs.existsSync(activeDemandPath) && options.createIfMissing === true) {
      const created = createActiveDemand(options.demandName);
      if (!created.ok) return created;
    }
    if (!fs.existsSync(activeDemandPath)) {
      return {
        ok: false,
        errorCode: 'REQUIREMENT_FINALIZE_ACTIVE_DEMAND_MISSING',
        message: `缺少 .active-demand，无法将需求最终产物绑定到具体需求目录：${activeDemandPath}`,
        activeDemandPath
      };
    }
    let demandName = String(fs.readFileSync(activeDemandPath, 'utf-8') || '').trim();
    if (!demandName && options.createIfMissing === true) {
      const created = createActiveDemand(options.demandName);
      if (!created.ok) return created;
      demandName = created.demandName;
    }
    if (!demandName) {
      return {
        ok: false,
        errorCode: 'REQUIREMENT_FINALIZE_ACTIVE_DEMAND_EMPTY',
        message: `.active-demand 为空，无法将需求最终产物绑定到具体需求目录：${activeDemandPath}`,
        activeDemandPath
      };
    }
    if (!this._isValidDemandName(demandName)) {
      return {
        ok: false,
        errorCode: 'REQUIREMENT_FINALIZE_DEMAND_NAME_INVALID',
        message: `.active-demand 指向非法需求名称：${demandName}`,
        activeDemandPath,
        demandName
      };
    }

    const lifecycle = this._resolveDemandClosureState(projectArtifactsDir, demandName);
    const pendingRequirement = this._readJsonIfExists(path.join(projectArtifactsDir, demandName, 'demand', 'analysis-state.json'));
    const revisionPending = pendingRequirement.ok && pendingRequirement.value?.revision
      && pendingRequirement.value.status !== 'done';
    if (options.requestMode === 'revise' || revisionPending) lifecycle.closed = false;
    const requestedRawDemandName = String(options.demandName || '').trim();
    let activeDemandRebound = false;
    let previousDemandName = '';
    let previousDemandClosure = null;
    if (options.forPrepareContext === true && requestedRawDemandName) {
      const requestedDemandName = this._ensureDemandNameWithDatePrefix(requestedRawDemandName);
      if (requestedDemandName !== demandName) {
        if (lifecycle.closed) {
          previousDemandName = demandName;
          previousDemandClosure = lifecycle;
          const created = createActiveDemand(requestedRawDemandName, {
            activeDemandRebound: true,
            previousDemandName: demandName,
            previousDemandClosure: lifecycle
          });
          if (!created.ok) return created;
          demandName = created.demandName;
          activeDemandRebound = true;
        } else {
          return {
            ok: false,
            errorCode: 'REQUIREMENT_ACTIVE_DEMAND_IN_PROGRESS',
            message: `.active-demand 当前指向未闭环需求：${demandName}。不能在旧需求未闭环时改绑到新需求：${requestedDemandName}`,
            activeDemandPath,
            demandName,
            requestedDemandName
          };
        }
      } else if (lifecycle.closed) {
        return {
          ok: false,
          errorCode: 'REQUIREMENT_ACTIVE_DEMAND_ALREADY_CLOSED',
          message: `.active-demand 当前指向已闭环需求：${demandName}（${lifecycle.closureLevel}），且本次 demandName 与旧需求同名。请换一个可区分的 2-8 字中文业务名后重调 req_prepare_context，或切换到 /epoint-requirement-design 继续旧需求。`,
          activeDemandPath,
          demandName,
          requestedDemandName,
          closureLevel: lifecycle.closureLevel,
          receiptPath: lifecycle.primaryReceipt && lifecycle.primaryReceipt.path || ''
        };
      }
    } else if (options.forPrepareContext === true && lifecycle.closed) {
      return {
        ok: false,
        errorCode: 'REQUIREMENT_ACTIVE_DEMAND_ALREADY_CLOSED',
        message: `.active-demand 当前指向已闭环需求：${demandName}（${lifecycle.closureLevel}）。如当前用户请求是新需求，请从用户原话派生 demandName 后重调 req_prepare_context，由 Builder 改绑 active-demand。`,
        activeDemandPath,
        demandName,
        closureLevel: lifecycle.closureLevel,
        receiptPath: lifecycle.primaryReceipt && lifecycle.primaryReceipt.path || ''
      };
    }

    const demandDir = path.resolve(projectArtifactsDir, demandName);
    if (!this._isSameOrChildPath(demandDir, projectArtifactsDir)) {
      return {
        ok: false,
        errorCode: 'REQUIREMENT_FINALIZE_DEMAND_DIR_OUT_OF_PROJECT',
        message: `.active-demand 指向非法需求目录：${demandName}`,
        activeDemandPath,
        demandName
      };
    }
    const demandArtifactDir = path.join(demandDir, 'demand');
    return {
      ok: true,
      projectArtifactsDir,
      activeDemandPath,
      demandName,
      demandDir,
      demandArtifactDir,
      demandAnalysisPath: path.join(demandArtifactDir, '需求分析.md'),
      analysisStatePath: path.join(demandArtifactDir, 'analysis-state.json'),
      ruleRecallRawPath: path.join(demandArtifactDir, 'rule-recall-raw.md'),
      rulePoolPath: path.join(demandArtifactDir, 'rule-pool.json'),
      storiesPath: path.join(demandArtifactDir, 'stories.json'),
      storiesReceiptPath: path.join(demandArtifactDir, 'stories-submit-receipt.json'),
      finalizeReceiptPath: path.join(demandArtifactDir, 'requirement-finalize-receipt.json'),
      activeDemandRebound,
      previousDemandName,
      previousDemandClosure
    };
  }

  _resolveActiveDemandCodePaths(projectPath) {
    const normalizedProject = path.resolve(String(projectPath || '').trim());
    const projectArtifactsDir = path.join(normalizedProject, '.ai-workspace', 'project');
    const activeDemandPath = path.join(projectArtifactsDir, '.active-demand');
    if (!fs.existsSync(activeDemandPath)) {
      return {
        ok: false,
        errorCode: 'DESIGN_TDD_ACTIVE_DEMAND_MISSING',
        message: `缺少 .active-demand，无法解析当前需求目录：${activeDemandPath}`,
        activeDemandPath
      };
    }
    const demandName = String(fs.readFileSync(activeDemandPath, 'utf-8') || '').trim();
    if (!demandName) {
      return {
        ok: false,
        errorCode: 'DESIGN_TDD_ACTIVE_DEMAND_EMPTY',
        message: `.active-demand 为空，无法解析当前需求目录：${activeDemandPath}`,
        activeDemandPath
      };
    }
    const demandDir = path.resolve(projectArtifactsDir, demandName);
    if (!this._isSameOrChildPath(demandDir, projectArtifactsDir)) {
      return {
        ok: false,
        errorCode: 'DESIGN_TDD_DEMAND_DIR_OUT_OF_PROJECT',
        message: `.active-demand 指向非法需求目录：${demandName}`,
        activeDemandPath,
        demandName
      };
    }
    const designDir = path.join(demandDir, 'design');
    const codeDir = path.join(demandDir, 'code');
    return {
      ok: true,
      projectArtifactsDir,
      activeDemandPath,
      demandName,
      demandDir,
      designDir,
      codeDir,
      designDocumentPath: path.join(designDir, '设计文档.json'),
      codeStatePath: path.join(codeDir, 'code-state.json')
    };
  }

  _cleanupSkeletonInputDirs(projectPath) {
    const normalizedProject = path.resolve(String(projectPath || '').trim());
    const summary = { removedCount: 0, removed: [], errors: [] };
    if (!normalizedProject || !fs.existsSync(normalizedProject)) return summary;

    const skipDirNames = new Set(['.git', 'node_modules']);
    const removeDir = dirPath => {
      try {
        fs.rmSync(dirPath, { recursive: true, force: true });
        summary.removedCount += 1;
        summary.removed.push(dirPath);
      } catch (error) {
        summary.errors.push({
          path: dirPath,
          message: String(error && error.message || error)
        });
      }
    };
    const visit = dirPath => {
      let entries = [];
      try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
      } catch (error) {
        summary.errors.push({
          path: dirPath,
          message: String(error && error.message || error)
        });
        return;
      }
      for (const entry of entries) {
        if (!entry || !entry.isDirectory()) continue;
        const childPath = path.join(dirPath, entry.name);
        if (!this._isSameOrChildPath(childPath, normalizedProject)) continue;
        if (entry.name === '.skeleton-input') {
          removeDir(childPath);
          continue;
        }
        if (skipDirNames.has(entry.name)) continue;
        visit(childPath);
      }
    };
    visit(normalizedProject);
    return summary;
  }


  _readNavigationContractForDesignPreflight(projectPath) {
    const projectArtifactsDir = path.join(path.resolve(String(projectPath || '').trim()), '.ai-workspace', 'project');
    const compactPath = path.join(projectArtifactsDir, '工程导航契约.compact.json');
    const fullPath = path.join(projectArtifactsDir, '工程导航契约.json');
    // design_prepare_context 与 design_tdd_build_plan 必须消费同一套导航真值。
    // 只要任一合同存在，就走 ContextService 的 full/compact 对账和修复，避免
    // 设计阶段先信任过期 compact，直到后面的 Builder/Coder 才暴露命名缺口。
    if (fs.existsSync(compactPath) || fs.existsSync(fullPath)) {
      const contextService = this.designTddContextService;
      if (contextService && typeof contextService._readNavigationContract === 'function') {
        return contextService._readNavigationContract({
          navigationCompactContractPath: compactPath,
          navigationContractPath: fullPath
        }, path.resolve(String(projectPath || '').trim()));
      }
    }
    const compact = this._readJsonIfExists(compactPath);
    if (compact.ok) {
      return { ok: true, value: compact.value, sourcePath: compactPath };
    }
    if (compact.exists && compact.error) {
      return {
        ok: false,
        errorCode: 'DESIGN_PREFLIGHT_NAVIGATION_CONTRACT_INVALID',
        message: `工程导航契约.compact.json 解析失败：${compactPath}`,
        sourcePath: compactPath
      };
    }
    const full = this._readJsonIfExists(fullPath);
    if (full.ok) {
      return { ok: true, value: full.value, sourcePath: fullPath };
    }
    if (full.exists && full.error) {
      return {
        ok: false,
        errorCode: 'DESIGN_PREFLIGHT_NAVIGATION_CONTRACT_INVALID',
        message: `工程导航契约.json 解析失败：${fullPath}`,
        sourcePath: fullPath
      };
    }
    return { ok: true, value: {}, sourcePath: '' };
  }

  /**
   * Builder 模式辅助：从需求阶段 rule-pool.json 派生 rule-bindings.json 快照。
   * 设计阶段不再把规则绑定到 entity/module；该文件仅记录需求规则池真值，供审计/hash 闭合。
   */
  _renderRuleBindingsFromRequirementRulePool(rulePool = {}, designPaths = {}) {
    const confirmedRules = this._collectRequirementRuleAliases(rulePool)
      .map(ruleAlias => ({ ruleAlias }));
    return {
      schemaVersion: 'rule-bindings/v3',
      managedBy: 'design_document_builder',
      bindingMode: 'requirement_rule_pool_snapshot',
      requirementRulePoolPath: String(designPaths && designPaths.requirementRulePoolPath || '').trim(),
      globalWhitelist: confirmedRules,
      globalBlocklist: this._slimRuleAliasObjects(rulePool && rulePool.globalBlocklist),
      storyRuleRecalls: (Array.isArray(rulePool && rulePool.storyRuleRecalls) ? rulePool.storyRuleRecalls : [])
        .map(entry => ({
          storyId: String(entry && (entry.storyId || entry.id || entry.userStoryId) || '').trim().toUpperCase(),
          acceptedRules: this._slimRuleAliasObjects(entry && entry.acceptedRules),
          baselineConstraints: this._slimRuleAliasObjects(entry && entry.baselineConstraints),
          unresolvedSignals: Array.isArray(entry && entry.unresolvedSignals) ? entry.unresolvedSignals.slice(0, 8) : []
        })),
      tableCandidatePoolConfirmed: rulePool && rulePool.tableCandidatePoolConfirmed === true,
      globalTableCandidateWhitelist: Array.isArray(rulePool && rulePool.globalTableCandidateWhitelist)
        ? rulePool.globalTableCandidateWhitelist.slice(0, 20)
        : []
    };
  }

  /**
   * Builder 模式辅助：从 designJson 派生 设计文档.md 文本（entity-first）。
   *
   * 章节结构：
   *   头部 meta / §1 Actor 列表 / §2 业务对象关系树 / §3 功能模块设计（按 entityKey 分块）
   *   / §4 数据库设计（4.1 设计说明 / 4.2 复用表 / 4.3 新建表字段 / 4.4 公共字段 / 4.5 主子表 / 4.6 业务约束 / 4.7 建表 SQL）
   *   / §5 配置设计 / §6 需求规则池快照。
   *
   * §3 内部从"按 storyId 7 块"变成"按 entityKey M 块"（用户期望 B 方案）：
   *   每个 entity 块展示 entityKey/displayName/businessObject/domain/bizModule/关联 storyIds/聚合 GWT/12 件套（一套，不重复）。
   *
   * 全部由 designJson 直接派生，0 个 LLM 占位。Coder 不消费 .md（只读 JSON），
   * .md 是给用户评审的人读视图——AGENTS.md "人读展示与机器合同分离" 红线。
   */
  _renderDesignMarkdownFromDesignJson(designJson = {}, requirementRulePool = {}) {
    const lines = [];
    const meta = designJson && designJson.meta || {};
    const entities = Array.isArray(designJson.businessEntities) ? designJson.businessEntities : [];
    const acceptanceCriteriaIndex = designJson.acceptanceCriteria && typeof designJson.acceptanceCriteria === 'object'
      ? designJson.acceptanceCriteria : {};
    const db = designJson.databaseDesign || {};
    const tables = Array.isArray(db.tables) ? db.tables : [];
    const today = new Date().toISOString().slice(0, 10);
    const requirementRules = this._collectRequirementRuleAliases(requirementRulePool);

    // 头部 meta
    lines.push(`# ${String(meta.name || '').trim()} — 设计文档`);
    lines.push('');
    lines.push(`> 分析日期：${today}`);
    lines.push('> 本文档由 design_prepare_context 触发 Builder 自动生成。机器合同请读 `设计文档.json`。');
    lines.push(`> 业务对象数：${entities.length}`);
    lines.push(`> 需求阶段确认规则数：${requirementRules.length}`);
    lines.push('');
    lines.push('---');
    lines.push('');

    // §1 Actor 列表（从 entity.relatedStories[].userStory 提取）
    lines.push('## 1. Actor 列表');
    lines.push('');
    const actorRows = this._extractActorsFromEntities(entities);
    if (actorRows.length === 0) {
      lines.push('（未识别到 Actor）');
    } else {
      lines.push('| Actor | 类型 | 来源业务对象 |');
      lines.push('|---|---|---|');
      actorRows.forEach(row => {
        lines.push(`| ${this._mdCell(row.actor)} | ${this._mdCell(row.type)} | ${this._mdCell(row.entityKeys.join('、'))} |`);
      });
    }
    lines.push('');
    lines.push('---');
    lines.push('');

    // §2 业务对象关系树
    lines.push('## 2. 业务对象关系树');
    lines.push('');
    lines.push('```text');
    this._renderEntityTree(entities, meta).forEach(line => lines.push(line));
    lines.push('```');
    lines.push('');
    lines.push('> 树主干按业务对象渲染：`[业务对象]` 标记主 entity，`承载于 <entityKey>` 表示子对象 entity 在父 entity 中维护。');
    lines.push('');
    lines.push('---');
    lines.push('');

    // §3 功能模块设计（按 entity 分块）
    lines.push('## 3. 功能模块设计');
    lines.push('');
    entities.forEach(entity => {
      const entityKey = entity.entityKey;
      lines.push(`### ${entityKey} ${entity.displayName || ''}`);
      lines.push('');
      lines.push(`- **业务对象**:${entity.businessObject || ''}`);
      lines.push(`- **聚合根**:${entity.aggregateRoot || entity.businessObject || ''}`);
      lines.push(`- **业务模块（bizModule）**:${entity.bizModule || ''}`);
      lines.push(`- **包路径业务大类（domain）**:${entity.domain || ''}`);
      lines.push(`- **实体类（entityName）**:${entity.entityName || ''}`);
      lines.push(`- **关联 Story**:${(Array.isArray(entity.relatedStoryIds) ? entity.relatedStoryIds : []).join('、') || '-'}`);
      const linkedTable = entity.linkedTable || {};
      if (linkedTable.kind === 'reuse') {
        lines.push(`- **关联表**:复用 \`${linkedTable.tableName || ''}\`（${linkedTable.tableComment || ''}）`);
        if (Array.isArray(linkedTable.reusedApis) && linkedTable.reusedApis.length > 0) {
          lines.push(`- **复用 API**:${linkedTable.reusedApis.join('、')}`);
        }
        if (linkedTable.reuseSourceFile) {
          lines.push(`- **复用落点**:${linkedTable.reuseSourceFile}`);
        }
      } else if (linkedTable.kind === 'new') {
        lines.push(`- **关联表**:新建（详见 §4.3）`);
      }
      if (entity.carriedByEntityKey) {
        lines.push(`- **承载于**:${entity.carriedByEntityKey}`);
      }
      lines.push('');

      // User Story 列表（按 relatedStories）
      const relatedStories = Array.isArray(entity.relatedStories) ? entity.relatedStories : [];
      if (relatedStories.length > 0) {
        lines.push('**User Stories**');
        lines.push('');
        relatedStories.forEach(s => {
          if (s && s.userStory) {
            lines.push(`> [${s.storyId}] ${s.userStory}`);
          }
        });
        lines.push('');
      }

      // 验收标准 GWT 表（来自顶层 acceptanceCriteriaIndex[entityKey]）
      const ac = acceptanceCriteriaIndex[entityKey] || {};
      const gwtRows = [];
      (Array.isArray(ac.happyPath) ? ac.happyPath : []).forEach(g => gwtRows.push({ type: 'Happy Path', ...g }));
      (Array.isArray(ac.exception) ? ac.exception : []).forEach(g => gwtRows.push({ type: '异常', ...g }));
      (Array.isArray(ac.boundary) ? ac.boundary : []).forEach(g => gwtRows.push({ type: '边界', ...g }));
      if (gwtRows.length > 0) {
        lines.push('**验收标准**（聚合自所有关联 Story）');
        lines.push('');
        lines.push('| 类型 | 来源 Story | 场景 | Given | When | Then |');
        lines.push('|---|---|---|---|---|---|');
        gwtRows.forEach(g => {
          lines.push(`| ${this._mdCell(g.type)} | ${this._mdCell(g.sourceStoryId || '')} | ${this._mdCell(g.scenario)} | ${this._mdCell(g.given)} | ${this._mdCell(g.when)} | ${this._mdCell(g.then)} |`);
        });
        lines.push('');
      }

      // 业务不变量（聚合所有 relatedStories.invariants）
      const allInvariants = [];
      relatedStories.forEach(s => {
        (Array.isArray(s.invariants) ? s.invariants : []).forEach(inv => allInvariants.push({ storyId: s.storyId, inv }));
      });
      if (allInvariants.length > 0) {
        lines.push('**业务不变量**');
        lines.push('');
        allInvariants.forEach(({ storyId, inv }) => lines.push(`- [${storyId}] ${inv}`));
        lines.push('');
      }

      // 后台文件 / 前端页面（resolvedFiles 镜像 entity.fileSet）
      const resolvedFiles = Array.isArray(entity.resolvedFiles) ? entity.resolvedFiles : [];
      const fileSet = resolvedFiles.length > 0 ? resolvedFiles : (Array.isArray(entity.fileSet) ? entity.fileSet : []);
      const backendFiles = fileSet.filter(f => f && f.fileKind && f.fileKind !== 'HtmlPage');
      const htmlFiles = fileSet.filter(f => f && f.fileKind === 'HtmlPage');
      if (entity.carriedByEntityKey && backendFiles.length === 0 && htmlFiles.length === 0) {
        lines.push(`**后台文件**:承载于 ${entity.carriedByEntityKey}，无独立后台文件`);
        lines.push('');
        lines.push(`**前端页面**:承载于 ${entity.carriedByEntityKey}，无独立页面`);
        lines.push('');
      } else if (linkedTable.kind === 'reuse' && fileSet.length === 0) {
        const reuseBackendHint = Array.isArray(linkedTable.reusedApis) && linkedTable.reusedApis.length > 0
          ? '调现成 API（见上方"复用 API"）'
          : (linkedTable.reuseSourceFile ? `读取复用落点 ${linkedTable.reuseSourceFile}` : '读取 scan 派生复用落点');
        lines.push(`**后台文件**:复用表 \`${linkedTable.tableName || ''}\`，${reuseBackendHint}，无独立 Entity/Service/Action`);
        lines.push('');
        lines.push(`**前端页面**:复用表无独立页面（如本 entity 需要页面，按已确认业务入口或后续编码计划处理）`);
        lines.push('');
      } else {
        if (backendFiles.length > 0) {
          lines.push('**后台文件**');
          lines.push('');
          lines.push('| 类型 | 子类型 | 路径 |');
          lines.push('|---|---|---|');
          backendFiles.forEach(f => {
            lines.push(`| ${this._mdCell(f.fileKind)} | ${this._mdCell(f.subType || '')} | ${this._mdCell(f.resolvedPath)} |`);
          });
          lines.push('');
        }
        if (htmlFiles.length > 0) {
          lines.push('**前端页面**');
          lines.push('');
          lines.push('| subType | 物理文件名 | 路径 |');
          lines.push('|---|---|---|');
          htmlFiles.forEach(f => {
            lines.push(`| ${this._mdCell(f.subType)} | ${this._mdCell(f.resolvedFileName || f.fileName || '')} | ${this._mdCell(f.resolvedPath)} |`);
          });
          lines.push('');
        }
      }
      lines.push('---');
      lines.push('');
    });

    // §4 数据库设计
    lines.push('## 4. 数据库设计');
    lines.push('');
    if (!db.required) {
      lines.push('本需求不涉及数据库设计。');
      lines.push('');
    } else {
      // 4.1 设计说明
      lines.push('### 4.1 设计说明');
      lines.push('');
      const aggregateRoots = Array.from(new Set(entities.map(e => e && (e.aggregateRoot || e.businessObject)).filter(Boolean)));
      const newTablesCount = tables.filter(t => !t.reuse).length;
      const reusedTablesCount = tables.filter(t => t.reuse).length;
      lines.push(`- 需求名称:${meta.name || ''}`);
      lines.push(`- 业务对象:${aggregateRoots.join('、') || '-'}`);
      lines.push(`- 设计状态:${db.status || ''}`);
      lines.push(`- 表总数:${tables.length}（新建 ${newTablesCount} / 复用 ${reusedTablesCount}）`);
      lines.push('');

      // 4.2 复用已有表
      const reusedTables = tables.filter(t => t.reuse);
      lines.push('### 4.2 复用已有表');
      lines.push('');
      if (reusedTables.length === 0) {
        lines.push('本需求无复用已有表。');
        lines.push('');
      } else {
        lines.push('| 表名 | 用途 | 复用 API / 落点 | 追加字段 | 关联业务对象 |');
        lines.push('|---|---|---|---|---|');
        reusedTables.forEach(t => {
          const apis = Array.isArray(t.reusedApis) ? t.reusedApis.join('、') : '';
          const reusePoint = apis || t.reuseSourceFile || (Array.isArray(t.reuseDirHints) ? t.reuseDirHints.join('、') : '');
          const append = Array.isArray(t.appendFields) && t.appendFields.length > 0
            ? t.appendFields.map(f => f.name || f).join('、')
            : '无';
          const related = Array.isArray(t.relatedEntityKeys) ? t.relatedEntityKeys.join('、') : '';
          lines.push(`| ${this._mdCell(t.tableName)} | ${this._mdCell(t.tableComment || '')} | ${this._mdCell(reusePoint)} | ${this._mdCell(append)} | ${this._mdCell(related)} |`);
        });
        lines.push('');
      }

      // 4.3 新建表结构草案
      const newTables = tables.filter(t => !t.reuse);
      if (newTables.length > 0) {
        lines.push('### 4.3 新建表结构草案');
        lines.push('');
        newTables.forEach((t, idx) => {
          lines.push(`#### 4.3.${idx + 1} ${t.tableComment || t.tableName}（\`${t.tableName}\`）`);
          lines.push('');
          const businessCols = (Array.isArray(t.columns) ? t.columns : []).filter(col => !this._isCommonColumn(col.name));
          if (businessCols.length > 0) {
            lines.push('| 序号 | 字段名 | 类型 | 长度 | 必填 | 含义 |');
            lines.push('|---|---|---|---|---|---|');
            businessCols.forEach((col, i) => {
              const len = col.length == null ? '-' : String(col.length);
              const req = col.required ? '是' : '否';
              lines.push(`| ${i + 1} | ${this._mdCell(col.name)} | ${this._mdCell(col.type)} | ${this._mdCell(len)} | ${this._mdCell(req)} | ${this._mdCell(col.comment || '')} |`);
            });
            lines.push('');
          }
        });

        // 4.4 公共字段
        lines.push('### 4.4 公共字段（每张新建表自动追加）');
        lines.push('');
        lines.push('| 字段名 | 类型 | 含义 |');
        lines.push('|---|---|---|');
        lines.push('| operatedate | DATETIME | 操作日期 |');
        lines.push('| operateusername | VARCHAR(50) | 操作人姓名 |');
        lines.push('| operateuserguid | VARCHAR(50) | 操作人 Guid |');
        lines.push('| operateuserouguid | VARCHAR(50) | 操作人所在部门 Guid |');
        lines.push('| operateuserbaseouguid | VARCHAR(50) | 操作人所在独立部门 Guid |');
        lines.push('| yearflag | VARCHAR(4) | 年份标识 |');
        lines.push('| belongxiaqucode | VARCHAR(50) | 所属辖区编号 |');
        lines.push('| pviguid | VARCHAR(50) | 工作流标识 |');
        lines.push('');

        // 4.5 主子表关系
        const masterDetailRows = this._collectMasterDetailRelations(entities, tables);
        if (masterDetailRows.length > 0) {
          lines.push('### 4.5 主子表关系');
          lines.push('');
          lines.push('| 主表 | 子表 | 说明 |');
          lines.push('|---|---|---|');
          masterDetailRows.forEach(row => {
            lines.push(`| ${this._mdCell(row.master)} | ${this._mdCell(row.detail)} | ${this._mdCell(row.note)} |`);
          });
          lines.push('');
        }

        // 4.6 业务约束
        const allConstraints = [];
        if (Array.isArray(db.constraints)) allConstraints.push(...db.constraints);
        tables.forEach(t => {
          if (Array.isArray(t.constraints)) allConstraints.push(...t.constraints);
        });
        if (allConstraints.length > 0) {
          lines.push('### 4.6 业务约束');
          lines.push('');
          allConstraints.forEach(c => {
            lines.push(`- ${typeof c === 'string' ? c : (c.description || JSON.stringify(c))}`);
          });
          lines.push('');
        }

        // 4.7 建表语句
        const createStatements = Array.isArray(db.createStatements) ? db.createStatements : [];
        if (createStatements.length > 0) {
          lines.push('### 4.7 建表语句草案');
          lines.push('');
          lines.push('```sql');
          lines.push('-- 仅为施工输入草案，最终 SQL 由 Coder 按项目规则复核后落地');
          createStatements.forEach(sql => {
            lines.push(String(sql || '').trim());
            lines.push('');
          });
          lines.push('```');
          lines.push('');
        }
      }
    }
    lines.push('---');
    lines.push('');

    // §5 配置设计
    const codeItemConfig = this._collectCodeItemConfiguration(tables);
    lines.push('## 5. 配置设计');
    lines.push('');
    lines.push('### 5.1 代码项字段绑定');
    lines.push('');
    if (codeItemConfig.bindings.length === 0) {
      lines.push('本需求无代码项字段绑定。');
    } else {
      lines.push('| 表名 | 字段 | 代码项名称 | 模式 | 来源 |');
      lines.push('|---|---|---|---|---|');
      codeItemConfig.bindings.forEach(binding => {
        lines.push(`| ${this._mdCell(binding.tableName)} | ${this._mdCell(binding.columnName)} | ${this._mdCell(binding.codeItem)} | ${this._mdCell(binding.mode)} | ${this._mdCell(binding.sourceRef)} |`);
      });
    }
    lines.push('');
    lines.push('### 5.2 新增代码项');
    lines.push('');
    if (codeItemConfig.newGroups.length === 0) {
      lines.push('本需求不新增代码项，不生成代码项导入SQL。');
    } else {
      lines.push('| 名称 | 值列表 |');
      lines.push('|---|---|');
      codeItemConfig.newGroups.forEach(group => {
        const valueList = group.codes
          .slice()
          .sort((left, right) => left.order - right.order)
          .map(code => `${code.codeValue}-${code.codeLabel}`)
          .join(', ');
        lines.push(`| ${this._mdCell(group.codeItem)} | ${this._mdCell(valueList)} |`);
      });
    }
    lines.push('');
    lines.push('### 5.3 复用代码项');
    lines.push('');
    if (codeItemConfig.reuseGroups.length === 0) {
      lines.push('本需求不复用既有代码项。');
    } else {
      lines.push('> 以下代码项只做字段绑定，不生成代码项导入SQL。');
      lines.push('');
      lines.push('| 名称 | Requirement事实ref |');
      lines.push('|---|---|');
      codeItemConfig.reuseGroups.forEach(group => {
        lines.push(`| ${this._mdCell(group.codeItem)} | ${this._mdCell(group.sourceRef)} |`);
      });
    }
    lines.push('');
    lines.push('---');
    lines.push('');

    // §6 需求规则池快照
    lines.push('## 6. 需求规则池快照');
    lines.push('');
    if (requirementRules.length === 0) {
      lines.push('需求阶段未确认业务规则；Coder 仍按文件类型读取平台基础规范。');
      lines.push('');
    } else {
      lines.push('| 规则别名 | 来源 |');
      lines.push('|---|---|');
      requirementRules.forEach(ruleAlias => {
        lines.push(`| ${this._mdCell(ruleAlias)} | demand/rule-pool.json |`);
      });
      lines.push('');
    }
    lines.push('---');
    lines.push('');

    lines.push('*本设计文档由 `epoint-requirement-design` Skill 通过 design_prepare_context 触发 Builder 自动生成；设计阶段不做 entity/module 规则绑定，规则真值来自需求阶段已确认的 `demand/rule-pool.json`。*');
    lines.push('');
    return lines.join('\n');
  }

  /**
   * 从 entity.relatedStories[].userStory 中提取 "作为 X，..." 的 X 作为 Actor。
   */
  _extractActorsFromEntities(entities = []) {
    const counts = new Map();
    const entityKeysByActor = new Map();
    let totalStories = 0;
    entities.forEach(entity => {
      const stories = Array.isArray(entity && entity.relatedStories) ? entity.relatedStories : [];
      stories.forEach(s => {
        const story = String(s && s.userStory || '').trim();
        const match = story.match(/^作为\s*([^，,]+?)\s*[,，]/u);
        if (!match) return;
        totalStories += 1;
        const actor = String(match[1] || '').trim();
        if (!actor) return;
        counts.set(actor, (counts.get(actor) || 0) + 1);
        if (!entityKeysByActor.has(actor)) entityKeysByActor.set(actor, new Set());
        entityKeysByActor.get(actor).add(entity.entityKey);
      });
    });
    if (counts.size === 0) return [];
    const total = totalStories || 1;
    const rows = [];
    counts.forEach((count, actor) => {
      const ratio = count / total;
      rows.push({
        actor,
        type: ratio >= 0.3 ? '主要' : '次要',
        entityKeys: Array.from(entityKeysByActor.get(actor) || [])
      });
    });
    rows.sort((a, b) => (b.entityKeys.length || 0) - (a.entityKeys.length || 0));
    return rows;
  }

  /**
   * 渲染 entity 关系树：业务对象作为根，carriedByEntityKey 关系作为子节点。
   */
  _renderEntityTree(entities = [], meta = {}) {
    const lines = [];
    const domain = String(meta.name || '功能域').trim();
    lines.push(`└─ ${domain}`);
    if (entities.length === 0) {
      lines.push('   （无业务对象）');
      return lines;
    }

    // 找出顶层 entity（无 carriedByEntityKey）+ 它们的子 entity（被 carry 的）
    const childrenByParent = new Map();
    const topLevel = [];
    entities.forEach(entity => {
      const parentKey = String(entity.carriedByEntityKey || '').trim();
      if (parentKey) {
        if (!childrenByParent.has(parentKey)) childrenByParent.set(parentKey, []);
        childrenByParent.get(parentKey).push(entity);
      } else {
        topLevel.push(entity);
      }
    });

    topLevel.forEach((entity, idx) => {
      const isLast = idx === topLevel.length - 1;
      const prefix = isLast ? '   └─' : '   ├─';
      const branch = isLast ? '     ' : '   │ ';
      const linkedTable = entity.linkedTable || {};
      const tableHint = linkedTable.kind === 'reuse'
        ? `（复用 ${linkedTable.tableName || ''}）`
        : (linkedTable.kind === 'new' ? '（新建表）' : '');
      lines.push(`${prefix} [业务对象] ${entity.entityKey} ${entity.displayName || ''}${tableHint}`);

      const children = childrenByParent.get(entity.entityKey) || [];
      children.forEach((child, ci) => {
        const isLastChild = ci === children.length - 1;
        const childPrefix = isLastChild ? '└─' : '├─';
        const childTableHint = (child.linkedTable && child.linkedTable.kind === 'reuse')
          ? `（复用 ${child.linkedTable.tableName || ''}）`
          : '';
        lines.push(`${branch}${childPrefix} [子对象] ${child.entityKey} ${child.displayName || ''}${childTableHint}（承载于 ${entity.entityKey}）`);
      });
    });
    return lines;
  }

  /**
   * 派生主子表关系：基于 entity carriedByEntityKey 关系。
   */
  _collectCodeItemConfiguration(tables = []) {
    const bindings = [];
    const newGroupMap = new Map();
    const reuseGroupMap = new Map();
    (Array.isArray(tables) ? tables : []).forEach(table => {
      const tableName = String(table && table.tableName || '').trim();
      const columns = Array.isArray(table && (table.businessColumns || table.columns || table.fields))
        ? (table.businessColumns || table.columns || table.fields)
        : [];
      columns.forEach(column => {
        const codeItem = String(column && column.codeItem || '').trim();
        if (!codeItem) return;
        const definition = column.codeItemDefinition && typeof column.codeItemDefinition === 'object'
          ? column.codeItemDefinition
          : {};
        const mode = String(definition.mode || 'unknown').trim();
        const sourceRef = mode === 'reuse'
          ? String(definition.sourceRef || '').trim()
          : (mode === 'new' ? '本需求新增' : '未提供');
        bindings.push({
          tableName,
          columnName: String(column && column.name || '').trim(),
          codeItem,
          mode,
          sourceRef
        });
        const key = codeItem.toLowerCase();
        if (mode === 'new' && !newGroupMap.has(key)) {
          newGroupMap.set(key, {
            codeItem,
            codes: (Array.isArray(definition.codes) ? definition.codes : []).map(code => ({
              codeValue: String(code && code.codeValue || '').trim(),
              codeLabel: String(code && code.codeLabel || '').trim(),
              order: Number(code && code.order || 0)
            }))
          });
        }
        if (mode === 'reuse' && !reuseGroupMap.has(key)) {
          reuseGroupMap.set(key, { codeItem, sourceRef });
        }
      });
    });
    return {
      bindings,
      newGroups: Array.from(newGroupMap.values()),
      reuseGroups: Array.from(reuseGroupMap.values())
    };
  }

  _recoverManagedProjectionTransaction(projectPath = '') {
    const paths = this._resolveActiveDemandCodePaths(projectPath);
    if (!paths || paths.ok !== true) return { ok: true, status: 'no_active_demand_wal' };
    const runtimeDir = path.join(paths.demandDir, 'runtime');
    const managedRoots = [paths.codeDir, paths.designDir, runtimeDir];
    const planRead = this._readJsonIfExists(path.join(paths.codeDir, 'design-tdd-plan.json'));
    const plan = planRead && planRead.ok === true ? (planRead.value || {}) : {};
    const projectRoot = path.resolve(String(projectPath || '').trim());
    const projectedSourceDirs = [];
    const addProjectedSourceDir = value => {
      const target = String(value || '').trim();
      if (!target || !path.isAbsolute(target)) return;
      const resolved = path.resolve(target);
      if (!this._isSameOrChildPath(resolved, projectRoot)) return;
      projectedSourceDirs.push(path.dirname(resolved));
    };
    (Array.isArray(plan.filePlan) ? plan.filePlan : []).forEach(file => addProjectedSourceDir(file && file.resolvedPath));
    (Array.isArray(plan.modulesOwnerFiles) ? plan.modulesOwnerFiles : []).forEach(module => {
      (Array.isArray(module && module.ownerFiles) ? module.ownerFiles : []).forEach(file => addProjectedSourceDir(file && file.resolvedPath));
    });
    managedRoots.push(...projectedSourceDirs);
    const candidates = new Set([
      ...managedRoots.map(root => path.join(root, 'projection-transaction.json')),
      ...managedRoots.map(root => path.join(root, '.projection-tx', 'projection-transaction.json'))
    ]);
    // 动态投影按事务建立 plan-<timestamp>-<pid> 子目录。恢复不能只查
    // .projection-tx/projection-transaction.json，否则进程在 apply 前退出时
    // 会留下 WAL 却被下一入口漏读，进而消费 plan/work-slices 的混合版本。
    managedRoots.forEach(root => {
      const transactionRoot = path.join(root, '.projection-tx');
      if (!fs.existsSync(transactionRoot)) return;
      try {
        fs.readdirSync(transactionRoot, { withFileTypes: true }).forEach(entry => {
          if (entry.isDirectory()) candidates.add(path.join(transactionRoot, entry.name, 'projection-transaction.json'));
        });
      } catch (_) {
        // 具体 WAL 读取/解析由 ProjectionTransactionService 统一返回 blocked。
      }
    });
    for (const transactionPath of candidates) {
      if (!fs.existsSync(transactionPath)) continue;
      const recovered = this.projectionTransactionService.recover({ managedRoots, transactionPath });
      if (!recovered || recovered.ok !== true) return recovered || {
        ok: false,
        status: 'blocked',
        errorCode: 'FRAMEWORK_PROJECTION_TRANSACTION_RECOVERY_DEFECT',
        message: `WAL 恢复失败：${transactionPath}`
      };
    }
    return { ok: true, status: 'recovered' };
  }

  _collectMasterDetailRelations(entities = [], tables = []) {
    const rows = [];
    entities.forEach(entity => {
      const parentKey = String(entity.carriedByEntityKey || '').trim();
      if (!parentKey) return;
      const parent = entities.find(e => e.entityKey === parentKey);
      if (!parent) return;
      const masterTable = this._findTableByEntity(parent, tables) || parent.entityKey;
      const detailTable = this._findTableByEntity(entity, tables) || entity.entityKey;
      rows.push({
        master: masterTable,
        detail: detailTable,
        note: `${entity.displayName || entity.entityKey} 在 ${parent.displayName || parent.entityKey} 详情/编辑页维护`
      });
    });
    return rows;
  }

  /**
   * 按 entity 反查关联 table（match relatedEntityKeys）。
   */
  _findTableByEntity(entity, tables = []) {
    if (!entity || !entity.entityKey) return '';
    const target = tables.find(t => Array.isArray(t.relatedEntityKeys) && t.relatedEntityKeys.includes(entity.entityKey));
    return target ? target.tableName : '';
  }

  /**
   * 公共字段名集合（与 Builder 自动追加的字段保持一致）。
   */
  _isCommonColumn(name) {
    const COMMON = new Set([
      'rowguid', 'row_id',
      'operatedate', 'operateusername', 'operateuserguid',
      'operateuserouguid', 'operateuserbaseouguid',
      'yearflag', 'belongxiaqucode', 'pviguid'
    ]);
    return COMMON.has(String(name || '').toLowerCase());
  }

  _collectRequirementRuleAliases(rulePool = {}) {
    const out = [];
    const seen = new Set();
    const pushAlias = (value) => {
      const alias = String(
        value && typeof value === 'object'
          ? (value.ruleAlias || value.ruleName || value.name || '')
          : (value || '')
      ).trim();
      if (!alias || seen.has(alias)) return;
      seen.add(alias);
      out.push(alias);
    };
    (Array.isArray(rulePool && rulePool.globalWhitelist) ? rulePool.globalWhitelist : []).forEach(pushAlias);
    if (out.length > 0) return out;
    (Array.isArray(rulePool && rulePool.storyRuleRecalls) ? rulePool.storyRuleRecalls : []).forEach(entry => {
      (Array.isArray(entry && entry.acceptedRules) ? entry.acceptedRules : []).forEach(pushAlias);
    });
    return out;
  }

  _slimRuleAliasObjects(values = []) {
    const seen = new Set();
    const out = [];
    for (const value of (Array.isArray(values) ? values : [])) {
      const ruleAlias = String(
        value && typeof value === 'object'
          ? (value.ruleAlias || value.ruleName || value.name || '')
          : (value || '')
      ).trim();
      if (!ruleAlias || seen.has(ruleAlias)) continue;
      seen.add(ruleAlias);
      const item = { ruleAlias };
      if (value && typeof value === 'object') {
        if (value.signal) item.signal = String(value.signal).trim();
        if (value.source) item.source = String(value.source).trim();
        if (value.storyId) item.storyId = String(value.storyId).trim().toUpperCase();
      }
      out.push(item);
    }
    return out;
  }

  /**
   * Builder 模式辅助：从 designJson 派生 rule-recall-raw.md 审计文本。
   */
  _renderRuleRecallRawFromRequirementRulePool(rulePool = {}, designPaths = {}) {
    const lines = [];
    lines.push('# 设计阶段规则池快照审计');
    lines.push('');
    lines.push('> 本文档由 design_prepare_context 触发 Builder 生成。设计阶段不重新做规则召回，也不把规则绑定到 entity/module；规则真值来自需求阶段已确认的 `rule-pool.json`。');
    if (designPaths && designPaths.requirementRuleRecallRawPath) {
      lines.push('');
      lines.push(`需求阶段召回审计：\`${designPaths.requirementRuleRecallRawPath}\``);
    }
    lines.push('');
    lines.push('## 已确认规则');
    lines.push('');
    const aliases = this._collectRequirementRuleAliases(rulePool);
    if (aliases.length === 0) {
      lines.push('- 无需求级业务规则；Coder 仅按文件类型读取平台基础规范。');
    } else {
      aliases.forEach(alias => lines.push(`- ${alias}`));
    }
    lines.push('');
    const blocked = this._slimRuleAliasObjects(rulePool && rulePool.globalBlocklist);
    if (blocked.length > 0) {
      lines.push('## 需求阶段剔除规则');
      lines.push('');
      blocked.forEach(rule => lines.push(`- ${rule.ruleAlias}`));
    }
    lines.push('');
    return lines.join('\n');
  }


  _readRequirementRulePoolForDesign(designPaths = {}) {
    const rulePoolPath = String(designPaths.requirementRulePoolPath || '').trim();
    const demandAnalysisPath = String(designPaths.demandAnalysisPath || '').trim();
    const analysisStatePath = String(designPaths.requirementAnalysisStatePath || '').trim();
    if (!rulePoolPath || !fs.existsSync(rulePoolPath)) {
      return { ok: false, exists: false, value: null, sourcePath: rulePoolPath, demandAnalysisText: '', analysisState: null };
    }
    try {
      const value = JSON.parse(fs.readFileSync(rulePoolPath, 'utf-8'));
      const demandAnalysisText = demandAnalysisPath && fs.existsSync(demandAnalysisPath)
        ? fs.readFileSync(demandAnalysisPath, 'utf-8')
        : '';
      let analysisState = null;
      if (analysisStatePath && fs.existsSync(analysisStatePath)) {
        try {
          analysisState = JSON.parse(fs.readFileSync(analysisStatePath, 'utf-8'));
        } catch (_) {
          analysisState = null;
        }
      }
      // 注入 stories.json storyIds，与 entry 阶段 _readRequirementRulePool 保持一致。
      // 避免 validateRulePool fallback 到 markdown/analysisState 解析 storyIds 失败
      // 导致假阳性 STORY_ANCHORS_EMPTY 阻断。
      let storyIds = null;
      const storiesJsonPath = String(designPaths.requirementStoriesPath || '').trim();
      if (storiesJsonPath && fs.existsSync(storiesJsonPath)) {
        try {
          const storiesJson = JSON.parse(fs.readFileSync(storiesJsonPath, 'utf-8'));
          if (storiesJson && Array.isArray(storiesJson.storyIds)) {
            storyIds = storiesJson.storyIds.slice();
          }
        } catch (_) { /* 解析失败走 fallback */ }
      }
      return {
        ok: true,
        exists: true,
        value,
        sourcePath: rulePoolPath,
        demandAnalysisText,
        analysisState,
        storyIds
      };
    } catch (error) {
      return {
        ok: false,
        exists: true,
        value: null,
        sourcePath: rulePoolPath,
        demandAnalysisText: '',
        analysisState: null,
        error
      };
    }
  }

  _validateDesignRuleBindingClosure(machineDesignJson = {}, ruleBindings = null, sourcePath = '') {
    return this.designRuleBindingValidatorService.validateRuleBindings(machineDesignJson, ruleBindings, {
      sourcePath
    });
  }

  _validateRuleBindingsAgainstRequirementPool(ruleBindings = null, requirementRulePoolRead = {}, designPaths = {}) {
    return this.requirementRulePoolService.validateRuleBindingsAgainstPool(ruleBindings, requirementRulePoolRead.value, {
      sourcePath: designPaths.ruleBindingsPath,
      poolPath: requirementRulePoolRead.sourcePath || designPaths.requirementRulePoolPath,
      demandMarkdown: requirementRulePoolRead.demandAnalysisText || '',
      analysisState: requirementRulePoolRead.analysisState || null,
      storyIds: requirementRulePoolRead.storyIds || null
    });
  }

  _buildRequirementRulePoolBlockedResponse(poolBindingResult = {}, message = '') {
    const issues = Array.isArray(poolBindingResult.issues) ? poolBindingResult.issues : [];
    return {
      ok: false,
      status: 'rule_binding_blocked',
      actionMode: 'stop_upstream_requirement_rule_pool_invalid',
      errorCode: 'REQUIREMENT_RULE_POOL_BINDING_VALIDATION_FAILED',
      requirementRulePoolLayer: {
        ok: false,
        issueCount: issues.length,
        sampleIssues: issues.slice(0, 8)
      },
      message: message || '需求阶段 rule-pool.json 状态无效，Design不能机械投影。回Requirement重新确认规则池；上游闭合后无phase调用design_prepare_context恢复，不要在Design内手改规则快照。',
      allowedNextActions: ['return_to_requirement_rule_pool'],
      forbiddenActions: ['write_design_document_json_directly', 'repair_rule_bindings_in_design', 'file_search', 'search_by_regex', 'view_folder']
    };
  }

  _buildDesignRuleBindingBlockedResponse(ruleBindingResult = {}, message = '') {
    const layer = ruleBindingResult.ruleBindingLayer || {};
    return {
      ok: false,
      status: 'rule_binding_blocked',
      actionMode: 'report_design_projection_defect',
      errorCode: 'RULE_BINDING_LAYER_VALIDATION_FAILED',
      ruleBindingLayer: layer,
      message: message || `Builder生成的规则池快照闭合校验失败，共 ${layer.issueCount || 0} 个问题；这是系统投影缺陷，不要求LLM修改业务答案或手写rule-bindings.json。`,
      allowedNextActions: ['report_design_projection_defect'],
      forbiddenActions: ['repair_business_answer', 'write_design_document_json_directly', 'repair_rule_bindings_in_design']
    };
  }

  _hashRuleBindingsForDesign(ruleBindings = null) {
    const source = ruleBindings && typeof ruleBindings === 'object' && !Array.isArray(ruleBindings)
      ? ruleBindings
      : {};
    return this._sha256(JSON.stringify(source));
  }

  _buildFileOutputSummary(designJson = {}) {
    const entities = Array.isArray(designJson && designJson.businessEntities) ? designJson.businessEntities : [];
    const overview = entities.map(entity => {
      const resolvedFiles = Array.isArray(entity && entity.resolvedFiles) ? entity.resolvedFiles : [];
      const fileSet = resolvedFiles.length > 0 ? resolvedFiles : (Array.isArray(entity && entity.fileSet) ? entity.fileSet : []);
      const groupsByKind = new Map();
      for (const file of fileSet) {
        if (!file || typeof file !== 'object') continue;
        const fileKind = String(file.fileKind || '').trim();
        if (!fileKind) continue;
        const current = groupsByKind.get(fileKind) || {
          fileKind,
          operations: [],
          count: 0,
          subTypes: [],
          examples: [],
          fileNames: []
        };
        const operation = String(file.operation || 'create').trim() || 'create';
        const subType = String(file.subType || '').trim();
        const fileName = String(file.resolvedFileName || file.fileName || '').trim();
        groupsByKind.set(fileKind, {
          ...current,
          operations: current.operations.includes(operation) ? current.operations : [...current.operations, operation],
          count: current.count + 1,
          subTypes: subType && !current.subTypes.includes(subType) ? [...current.subTypes, subType] : current.subTypes,
          examples: fileName && current.examples.length < 3 && !current.examples.includes(fileName)
            ? [...current.examples, fileName]
            : current.examples,
          fileNames: fileName && !current.fileNames.includes(fileName) ? [...current.fileNames, fileName] : current.fileNames
        });
      }
      const groups = Array.from(groupsByKind.values()).map(group => {
        const groupOperation = group.operations.length === 1 ? group.operations[0] : 'mixed';
        const result = {
          fileKind: group.fileKind,
          operation: groupOperation,
          count: group.count
        };
        if (group.subTypes.length > 0) result.subTypes = group.subTypes;
        if (group.count > 1 && group.fileNames.length > 0) {
          result.fileNamePattern = this._deriveFileNamePattern(group.fileNames);
        } else if (group.examples.length > 0) {
          result.examples = group.examples;
        }
        return result;
      });
      const operations = Array.from(new Set(groups.map(group => group.operation).filter(Boolean)));
      return {
        entityKey: String(entity && entity.entityKey || '').trim(),
        displayName: String(entity && entity.displayName || '').trim(),
        operation: operations.length === 1 ? operations[0] : 'mixed',
        count: groups.reduce((sum, group) => sum + group.count, 0),
        groups
      };
    }).filter(item => item.count > 0);
    return {
      fileOutputCount: overview.reduce((sum, item) => sum + item.count, 0),
      fileOutputOverview: overview
    };
  }

  _buildDesignHandoffCard(designJson = {}, options = {}) {
    const summary = options.summary || this._buildFileOutputSummary(designJson);
    const tableList = Array.isArray(designJson && designJson.databaseDesign && designJson.databaseDesign.tables)
      ? designJson.databaseDesign.tables
      : [];
    const newTableNames = tableList
      .filter(table => table && table.reuse !== true)
      .map(table => String(table && table.tableName || '').trim())
      .filter(Boolean);
    const reuseTableNames = tableList
      .filter(table => table && table.reuse === true)
      .map(table => String(table && table.tableName || '').trim())
      .filter(Boolean);
    const sqlArtifactsReady = options.sqlArtifactsReady === true;
    const workflowArtifactsReady = options.workflowArtifactsReady === true;
    const documentationTaskCardAvailable = options.documentationTaskCardAvailable === true;
    const requiresSqlGeneration = newTableNames.length > 0 && !sqlArtifactsReady;
    const requiresSilentContinuation = requiresSqlGeneration || documentationTaskCardAvailable;
    const demandName = String(options.demandName || designJson && designJson.meta && designJson.meta.name || '').trim();
    const lines = [
      demandName ? `设计文档已生成：${demandName}` : '设计文档已生成',
      `文件输出：${Number(summary && summary.fileOutputCount || 0)} 个文件项`,
      newTableNames.length > 0 ? `新建表：${newTableNames.join('、')}` : '新建表：无',
      reuseTableNames.length > 0 ? `复用表：${reuseTableNames.join('、')}` : '复用表：无',
      requiresSqlGeneration
        ? `自动衔接：${workflowArtifactsReady ? '工作流XML已在设计阶段生成。' : ''}立即静默调用 $design-to-sql，使用 Builder 已从设计JSON生成的 dsl.json，仅生成导入 SQL；成功后重新调用 design_prepare_context 获取含实际SQL路径的交付说明卡。SQL 只生成不执行。`
        : (documentationTaskCardAvailable
          ? `${sqlArtifactsReady ? '数据库辅助产物已生成。' : ''}${workflowArtifactsReady ? '工作流XML已在设计阶段生成。' : ''}按 documentationTaskCard 生成交付说明设计稿后进入 TDD 编码阶段。`
          : '下一步：确认设计产物已写入后进入 TDD 编码阶段')
    ];

    return {
      title: '设计文档已生成',
      displayMode: requiresSilentContinuation ? 'intermediate_silent_auto_continue' : 'builder_rendered_final_reply',
      replyText: lines.join('\n'),
      outputPolicy: requiresSqlGeneration
        ? '本卡是中间动作卡，不是最终回复。立即静默执行 postDesignNextAction；design-to-sql完成并恢复交付说明卡前禁止向用户提问或输出最终回复。'
        : (documentationTaskCardAvailable
          ? '本卡是中间动作卡。先尝试生成交付说明设计稿；失败只报告warning，随后继续TDD编码阶段。'
          : '最终回复先按 designSelfReviewCard 判断“可进入编码/建议回修设计”，再原样复述 replyText；不得从文件名、页面名或业务名推导表名。'),
      nextAction: requiresSqlGeneration
        ? '立即静默调用 $design-to-sql，成功后重新调用 design_prepare_context 获取交付说明卡'
        : (documentationTaskCardAvailable
          ? '按documentationTaskCard生成交付说明设计稿后进入TDD编码阶段'
          : '确认设计产物已写入后进入 TDD 编码阶段')
    };
  }

  _buildDesignSelfReviewCard(designJson = {}) {
    const tableList = Array.isArray(designJson && designJson.databaseDesign && designJson.databaseDesign.tables)
      ? designJson.databaseDesign.tables
      : [];
    const newTables = tableList.filter(table => table && table.reuse !== true);
    return {
      title: '设计完成前 LLM 自审卡',
      isGate: false,
      instruction: '最终回复前先按本卡判断：可进入编码 / 建议回修设计；本卡不阻断工具结果。',
      checklist: [
        '每个 Story 的结果事实、承载角色和施工场景是否闭合。',
        '新建表的唯一身份/业务粒度是否清楚，字段是否覆盖 userStory、验收标准、不变量和按需的workflow/statistics/codingFactHandoff。',
        '查询/统计是否说清读取新表、复用表、上游汇总还是实时原始明细；carriedByEntityKey 是否只用于读取本次新表。',
        '工作流是否区分流程申请/审批事实和被查看业务数据。',
        'REST 是否从外部调用方视角写清操作、请求事实和返回事实。',
        '表名是否可读，tableFeatureName 是否没有重复模块缩写或工程表前缀。',
        'Coder 是否能直接按设计机器合同施工，不需要再猜字段、接口、表承载或路线。'
      ],
      newTableCount: newTables.length,
      newTableNames: newTables.map(table => String(table && table.tableName || '').trim()).filter(Boolean),
      expectedDecisionValues: ['可进入编码', '建议回修设计']
    };
  }

  _buildDesignPostFinalizeNextAction(designJson = {}, designPaths = {}, projectPath = '') {
    const tableList = Array.isArray(designJson && designJson.databaseDesign && designJson.databaseDesign.tables)
      ? designJson.databaseDesign.tables
      : [];
    const newTableNames = tableList
      .filter(table => table && table.reuse !== true)
      .map(table => String(table && table.tableName || '').trim())
      .filter(Boolean);
    if (newTableNames.length === 0) {
      return {
        required: false,
        reason: 'no_new_tables',
        allowedNextActions: ['confirm_design_artifacts_written_then_continue_to_tdd']
      };
    }
    const dslMaterialized = this.designTddSqlDslService.materialize({
      designJson,
      designDir: designPaths.designDir
    });
    const existingArtifacts = this._collectFreshDesignSqlArtifacts(designPaths);
    if (existingArtifacts.sqlPaths.length > 0 && existingArtifacts.dslPath) {
      return {
        required: false,
        reason: 'sql_artifacts_present',
        sqlArtifactPaths: existingArtifacts.sqlPaths,
        dslPath: existingArtifacts.dslPath,
        dslMaterialized: dslMaterialized.ok === true,
        allowedNextActions: ['generate_design_delivery_draft_then_continue_to_tdd']
      };
    }
    const designMarkdownPath = String(designPaths && designPaths.designMarkdownPath || '').trim();
    return {
      required: true,
      actionMode: 'call_design_to_sql_before_tdd',
      executionMode: 'silent_auto_continue',
      requiresUserConfirmation: false,
      stopAfterDisplay: false,
      mustExecuteBeforeFinalReply: true,
      toolKind: 'skill',
      skillName: 'design-to-sql',
      reason: '设计文档存在 reuse !== true 的新建表；按历史合同必须先调用 $design-to-sql 生成数据库辅助产物。',
      dslMaterialized: dslMaterialized.ok === true,
      ...(dslMaterialized.ok !== true ? { dslMaterializeWarning: dslMaterialized.errorCode } : {}),
      newTableNames,
      argumentsShape: {
        dslPath: path.join(String(designPaths && designPaths.designDir || '').trim(), 'dsl.json'),
        designMarkdownPath,
        projectPath: String(projectPath || '').trim(),
        demandDir: String(designPaths && designPaths.demandDir || '').trim(),
        designDir: String(designPaths && designPaths.designDir || '').trim()
      },
      expectedOutputs: ['dsl.json', 'init-import.sql/init-import-oracle.sql/init-import-dm.sql'],
      afterSuccess: 'resume_design_prepare_context_for_delivery_draft_then_continue_to_tdd',
      forbiddenActions: [
        'ask_user_whether_to_continue_to_design_to_sql',
        'final_answer_before_design_to_sql_completed',
        'skip_design_to_sql_when_new_tables_exist',
        'write_sql_by_hand_in_requirement_design_skill'
      ]
    };
  }

  _collectFreshDesignSqlArtifacts(designPaths = {}) {
    const designDir = String(designPaths && designPaths.designDir || '').trim();
    const designMarkdownPath = String(designPaths && designPaths.designMarkdownPath || '').trim();
    if (!designDir || !designMarkdownPath || !fs.existsSync(designMarkdownPath)) {
      return { dslPath: '', sqlPaths: [] };
    }
    const designMtime = fs.statSync(designMarkdownPath).mtimeMs;
    const existingNonEmptyFile = filePath => {
      if (!fs.existsSync(filePath)) return '';
      const stat = fs.statSync(filePath);
      return stat.isFile() && stat.size > 0 ? filePath : '';
    };
    const existingFreshSql = filePath => {
      const existing = existingNonEmptyFile(filePath);
      return existing && fs.statSync(existing).mtimeMs >= designMtime ? existing : '';
    };
    // design-to-sql允许复用未变化的dsl.json，因此只要求最终SQL新于当前设计。
    const dslPath = existingNonEmptyFile(path.join(designDir, 'dsl.json'));
    const sqlPaths = ['init-import.sql', 'init-import-oracle.sql', 'init-import-dm.sql']
      .map(name => existingFreshSql(path.join(designDir, name)))
      .filter(Boolean);
    return { dslPath, sqlPaths };
  }

  _buildDesignCompletionContinuation(designJson = {}, designPaths = {}, projectPath = '', summary = null) {
    const outputSummary = summary || this._buildFileOutputSummary(designJson);
    const workflowArtifacts = this.designWorkflowArtifactService.materialize({
      designDir: designPaths.designDir,
      design: designJson,
      designJsonPath: designPaths.designJsonPath
    });
    if (!workflowArtifacts.ok) {
      const blockedAction = {
        ...workflowArtifacts,
        required: true,
        actionMode: 'report_design_workflow_artifact_failure',
        executionMode: 'builder_blocked',
        requiresUserConfirmation: false,
        stopAfterDisplay: true,
        mustExecuteBeforeFinalReply: true,
        allowedNextActions: workflowArtifacts.allowedNextActions || ['report_design_workflow_artifact_failure'],
        forbiddenActions: Array.from(new Set([
          ...(workflowArtifacts.forbiddenActions || []),
          'advance_to_coder',
          'generate_workflow_xml_in_coder',
          'generate_workflow_xml_in_skeleton'
        ]))
      };
      return {
        designSelfReviewCard: this._buildDesignSelfReviewCard(designJson),
        postDesignNextAction: blockedAction,
        immediateNextAction: blockedAction,
        allowedNextActions: blockedAction.allowedNextActions,
        forbiddenActions: blockedAction.forbiddenActions
      };
    }
    const workflowArtifactsIndex = {
      artifacts: (workflowArtifacts.artifacts || []).map(item => ({
        ...item,
        consumerSkill: 'epoint-workflow-coder',
        source: 'requirement_design_finalize'
      }))
    };
    const postDesignNextAction = {
      ...this._buildDesignPostFinalizeNextAction(designJson, designPaths, projectPath),
      workflowArtifactsReady: workflowArtifacts.required === true,
      workflowArtifactCount: (workflowArtifacts.artifacts || []).length,
      ...(workflowArtifacts.required === true
        ? { workflowArtifactReceiptPath: workflowArtifacts.receiptPath }
        : {})
    };
    const documentationContext = postDesignNextAction.required ? { card: null } : this._buildDesignTddDocumentationContext({
      projectPath,
      documentStage: 'design',
      documentationSkillName: 'epoint-requirement-design',
      generatedArtifactsIndex: workflowArtifactsIndex,
      additionalInputRefs: workflowArtifacts && workflowArtifacts.required === true && workflowArtifacts.receiptPath
        ? [{ kind: 'workflow_artifacts_receipt', path: workflowArtifacts.receiptPath }]
        : [],
      codePaths: {
        demandDir: designPaths.demandDir,
        codeDir: path.join(designPaths.demandDir, 'code'),
        designDocumentPath: designPaths.designJsonPath,
        designMarkdownPath: designPaths.designMarkdownPath,
        requirementStoriesPath: designPaths.requirementStoriesPath,
        requirementRulePoolPath: designPaths.requirementRulePoolPath,
        deliveryFactsPath: designPaths.deliveryFactsPath,
        documentationTaskCardPath: designPaths.documentationTaskCardPath,
        codeStatePath: '',
        finalizeReceiptPath: path.join(designPaths.designDir, 'design-finalize-receipt.json')
      }
    });
    const allowedNextActions = documentationContext.card
      ? ['generate_design_delivery_draft_then_continue_to_tdd']
      : (postDesignNextAction.required
        ? ['invoke_design_to_sql_then_resume_for_delivery_draft']
        : ['confirm_design_artifacts_written_then_continue_to_tdd']);
    const forbiddenActions = Array.from(new Set([
      'final_answer_before_design_artifacts_written',
      'write_design_document_json_directly',
      ...(postDesignNextAction.required ? postDesignNextAction.forbiddenActions || [] : [])
    ]));
    return {
      handoffCard: this._buildDesignHandoffCard(designJson, {
        demandName: designPaths.demandName,
        summary: outputSummary,
        designMarkdownPath: designPaths.designMarkdownPath,
        sqlArtifactsReady: postDesignNextAction.reason === 'sql_artifacts_present',
        workflowArtifactsReady: postDesignNextAction.workflowArtifactsReady === true,
        documentationTaskCardAvailable: !!documentationContext.card
      }),
      designSelfReviewCard: this._buildDesignSelfReviewCard(designJson),
      postDesignNextAction,
      ...(postDesignNextAction.required ? { immediateNextAction: postDesignNextAction } : {}),
      allowedNextActions,
      ...(documentationContext.card ? {
        documentationTaskCard: documentationContext.card,
        documentationNextAction: {
          action: 'generate_design_delivery_draft',
          then: 'continue_to_tdd'
        }
      } : {}),
      ...(documentationContext.warning ? { documentationWarning: documentationContext.warning } : {}),
      forbiddenActions
    };
  }

  _enrichCompletedDesignResult(workflowResult = {}, projectPath = '') {
    if (!workflowResult || workflowResult.ok !== true || workflowResult.designFinalized !== true
      || workflowResult.postDesignNextAction) return workflowResult;
    const designPaths = this._resolveActiveDemandDesignPaths(projectPath);
    if (!designPaths.ok) return workflowResult;
    const designRead = this._readJsonIfExists(designPaths.designJsonPath);
    if (!designRead.ok || !designRead.value) return workflowResult;
    return {
      ...workflowResult,
      ...this._buildDesignCompletionContinuation(designRead.value, designPaths, projectPath)
    };
  }

  _deriveFileNamePattern(examples = []) {
    const names = examples.map(item => String(item || '').trim()).filter(Boolean);
    if (names.length === 0) return '';
    if (names.length === 1) return names[0];
    let prefix = names[0];
    for (const name of names.slice(1)) {
      while (prefix && !name.startsWith(prefix)) {
        prefix = prefix.slice(0, -1);
      }
    }
    let suffix = names[0];
    for (const name of names.slice(1)) {
      while (suffix && !name.endsWith(suffix)) {
        suffix = suffix.slice(1);
      }
    }
    if (!prefix && !suffix) return names[0];
    if (prefix.length + suffix.length >= names[0].length) return names[0];
    return `${prefix}*${suffix}`;
  }

  _prepareFinalDesignMarkdown(designMarkdown = '', designJson = {}, navigationContract = {}) {
    const resolved = this._resolveDesignHtmlPageNames(designJson, navigationContract);
    if (resolved.ok !== true) {
      return resolved;
    }
    let markdown = String(designMarkdown || '');
    for (const page of resolved.pages) {
      const candidates = [
        `${page.pageName}${page.subType}.html`,
        `${page.pageName}${this._upperFirst(page.subType)}.html`,
        `gxh${page.pageName}${this._upperFirst(page.subType)}.html`
      ];
      for (const candidate of Array.from(new Set(candidates))) {
        if (!candidate || candidate === page.resolvedFileName) continue;
        markdown = this._replaceStandaloneFileToken(markdown, candidate, page.resolvedFileName);
      }
    }
    if (resolved.pages.length > 0) {
      markdown = this._upsertDesignHtmlPageResolutionSection(markdown, resolved.pages);
    }
    return {
      ok: true,
      markdown,
      resolvedHtmlPages: resolved.pages
    };
  }

  _resolveDesignHtmlPageNames(designJson = {}, navigationContract = {}) {
    // entity 重构后：HtmlPage 4 件套 resolvedPath 已由 Builder._buildEntityFileSet 派生到
    // entity.fileSet[]（含 fileKind=HtmlPage / subType / resolvedPath / fileName）。
    // 这里只需要从 entity.fileSet 收集 HtmlPage 项，不再做二次模板渲染。
    const entities = Array.isArray(designJson && designJson.businessEntities) ? designJson.businessEntities : [];
    const pages = [];
    for (const entity of entities) {
      const entityKey = String(entity && entity.entityKey || '').trim();
      const fileSet = Array.isArray(entity && entity.fileSet) ? entity.fileSet : [];
      const bizModule = String(entity && entity.bizModule || '').trim();
      const pageName = String(entity && entity.pageName || bizModule || '').trim();
      for (const file of fileSet) {
        const fileKind = String(file && file.fileKind || '').trim();
        if (fileKind !== 'HtmlPage') continue;
        const subType = String(file && file.subType || '').trim().toLowerCase();
        const resolvedFileName = String(file && file.fileName || '').trim();
        const resolvedPath = String(file && file.resolvedPath || '').trim();
        if (!subType || !resolvedFileName) {
          return this._blockedDesignMarkdownResolve('DESIGN_FINALIZE_HTML_FILESET_INCOMPLETE',
            `entity ${entityKey || '?'} HtmlPage fileSet 缺少 subType/fileName，Builder 派生失败。`,
            { entityKey, subType });
        }
        pages.push({
          entityKey,
          subType,
          pageName,
          pagename: pageName,
          bizModule,
          resolvedFileName,
          resolvedPath
        });
      }
    }
    return { ok: true, pages };
  }

  _getDesignCodingHandoff(module = {}) {
    const candidates = [
      module && module.codingHandoff,
      module && module.codeHandoff,
      module && module.codePlanSeed,
      module && module.codePlanSeeds,
      module && module.implementationHandoff
    ];
    return candidates.find(item => item && typeof item === 'object' && !Array.isArray(item)) || {};
  }

  _getDesignHtmlPageSeeds(module = {}, handoff = {}) {
    const raw = Array.isArray(handoff.htmlPages) && handoff.htmlPages.length > 0
      ? handoff.htmlPages
      : (Array.isArray(handoff.pageSeeds) ? handoff.pageSeeds : []);
    if (raw.length > 0) {
      return raw.filter(item => item && typeof item === 'object');
    }
    const subTypes = Array.isArray(handoff.pageSubTypes) ? handoff.pageSubTypes : [];
    return subTypes.map(subType => ({
      subType,
      pageName: handoff.pageName || handoff.pagename || module.pageName || module.pagename || '',
      bizModule: handoff.bizModule || module.bizModule || ''
    }));
  }

  _upsertDesignHtmlPageResolutionSection(markdown = '', pages = []) {
    const start = '<!-- DESIGN_FINALIZER_HTML_PAGE_NAMES_START -->';
    const end = '<!-- DESIGN_FINALIZER_HTML_PAGE_NAMES_END -->';
    const lines = [
      start,
      '',
      '## HtmlPage 命名解析（系统生成）',
      '',
      '| 业务对象 | subType | pageName | 物理文件名 |',
      '|---|---|---|---|'
    ];
    pages.forEach(page => {
      lines.push(`| ${this._mdCell(page.entityKey)} | ${this._mdCell(page.subType)} | ${this._mdCell(page.pageName)} | ${this._mdCell(page.resolvedFileName)} |`);
    });
    lines.push('', end);
    const section = lines.join('\n');
    const text = String(markdown || '').trimEnd();
    const existing = new RegExp(`${this._escapeRegExp(start)}[\\s\\S]*?${this._escapeRegExp(end)}`, 'u');
    if (existing.test(text)) {
      return text.replace(existing, section);
    }
    const footer = /\n\*本设计文档由 `epoint-requirement-design` Skill 生成[\s\S]*$/u;
    if (footer.test(text)) {
      return text.replace(footer, `\n\n${section}$&`);
    }
    return `${text}\n\n${section}`;
  }

  _blockedDesignMarkdownResolve(errorCode, message, extra = {}) {
    return {
      ok: false,
      status: 'blocked',
      actionMode: 'upstream_design_repair',
      errorCode,
      message,
      ...extra
    };
  }

  _applyTemplate(template = '', values = {}) {
    return String(template || '').replace(/\{([^}]+)\}/gu, (match, key) =>
      Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
    );
  }

  _hasUnresolvedPlaceholder(value = '') {
    return /\{[^}]+\}/u.test(String(value || ''));
  }

  _upperFirst(value = '') {
    const text = String(value || '').trim();
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
  }

  _escapeRegExp(value = '') {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  }

  _replaceStandaloneFileToken(text = '', token = '', replacement = '') {
    const pattern = new RegExp(`(^|[^A-Za-z0-9_])${this._escapeRegExp(token)}(?=$|[^A-Za-z0-9_])`, 'gu');
    return String(text || '').replace(pattern, (match, prefix) => `${prefix || ''}${replacement}`);
  }

  _normalizeSlash(value = '') {
    return String(value || '').replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  }

  _mdCell(value = '') {
    return String(value == null ? '' : value)
      .replace(/\r?\n/gu, '<br>')
      .replace(/\|/gu, '\\|');
  }

  _readRuleExpertContent(input = {}) {
    const ruleName = String(input.ruleName || '').trim();
    const versionBucket = String(input.versionBucket || '').trim();
    const projectPath = input.projectPath;
    if (versionBucket && this.ruleService && typeof this.ruleService.resolveVersionedRule === 'function') {
      const resolvedVersioned = this.ruleService.resolveVersionedRule({
        alias: ruleName,
        versionBucket,
        projectPath
      });
      if (resolvedVersioned && resolvedVersioned.content) {
        const resolvedRule = resolvedVersioned.rule || {};
        return {
          content: resolvedVersioned.content,
          ruleName,
          resolvedRuleName: resolvedRule.name || ruleName,
          ruleAlias: resolvedRule.ruleAlias || ruleName,
          versionBucket: resolvedRule.versionBucket || versionBucket
        };
      }
    }
    const content = this.ruleService.getRuleContentByPolicy(ruleName, { projectPath });
    const resolved = this.ruleService.resolveRule(ruleName, { projectPath });
    return {
      content,
      ruleName,
      resolvedRuleName: resolved && resolved.name || ruleName,
      ruleAlias: path.basename(resolved && resolved.name || ruleName),
      versionBucket: ''
    };
  }

  // 解析当前 Planner outputDir：优先 outputLock，其次按 projectPath + 已锁定的需求短名匹配 .planner-output-locks.json。
  // 解析失败返回空串，调用方应跳过自动持久化（保持原行为）。
  _resolvePlannerOutputDirForAuth(input = {}, parameters = {}) {
    const direct = String(
      parameters.outputDir
      || input.outputDir
      || input.outputLock && input.outputLock.outputDir
      || ''
    ).trim();
    if (direct) {
      return path.resolve(direct);
    }
    const projectPath = String(parameters.projectPath || input.projectPath || '').trim();
    if (!projectPath) return '';
    const lockPath = path.join(projectPath, '.ai-workspace', 'project', '.planner-output-locks.json');
    if (!fs.existsSync(lockPath)) return '';
    try {
      const lockState = JSON.parse(fs.readFileSync(lockPath, 'utf-8') || '{}');
      const locks = Array.isArray(lockState && lockState.locks) ? lockState.locks : [];
      // 优先选 status=locked 且 outputDir 真实存在的锁；按 createdAt 取最近的一条。
      const candidate = locks
        .filter(item => item && String(item.status || '').trim() === 'locked')
        .filter(item => item.outputDir && fs.existsSync(String(item.outputDir)))
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
      return candidate ? path.resolve(String(candidate.outputDir)) : '';
    } catch (_) {
      return '';
    }
  }

  // rule_expert(analyze) 后把 acceptedRules / unresolvedSignals 合并进 planner-authoring-input.json。
  // 这样 Builder/Gate 看到的 authorityMode/ruleBodyReadRequired/referencePolicy/signal 与 analyze 输出一致，AI 不再当搬运工。
  _persistAcceptedRulesToAuthoringSnapshot(args = {}, ruleAnalyzeResult = null) {
    if (!ruleAnalyzeResult || typeof ruleAnalyzeResult !== 'object') return;
    const parameters = args && args.parameters && typeof args.parameters === 'object' ? args.parameters : {};
    const outputDir = this._resolvePlannerOutputDirForAuth(args, parameters);
    if (!outputDir) return;
    const snapshotPath = path.join(outputDir, 'planner-authoring-input.json');
    const acceptedRules = Array.isArray(ruleAnalyzeResult.acceptedRules) ? ruleAnalyzeResult.acceptedRules : [];
    const projectTableCandidates = Array.isArray(ruleAnalyzeResult.projectTableCandidates) ? ruleAnalyzeResult.projectTableCandidates : [];
    const unresolvedSignals = Array.isArray(ruleAnalyzeResult.unresolvedSignals) ? ruleAnalyzeResult.unresolvedSignals : [];
    if (acceptedRules.length === 0 && unresolvedSignals.length === 0 && projectTableCandidates.length === 0) return;
    let snapshot = null;
    if (fs.existsSync(snapshotPath)) {
      try { snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8')); } catch (_) { snapshot = null; }
    }
    if (!snapshot || typeof snapshot !== 'object') {
      snapshot = { schemaVersion: 'planner-authoring-input/v1', outputDir };
    }
    if (!snapshot.plannerOwned || typeof snapshot.plannerOwned !== 'object') {
      snapshot.plannerOwned = {};
    }
    const existingAcceptedRules = Array.isArray(snapshot.plannerOwned.acceptedRules)
      ? snapshot.plannerOwned.acceptedRules
      : [];
    const existingUnresolvedSignals = Array.isArray(snapshot.plannerOwned.unresolvedSignals)
      ? snapshot.plannerOwned.unresolvedSignals
      : [];
    const existingProjectTableCandidates = Array.isArray(snapshot.plannerOwned.projectTableCandidates)
      ? snapshot.plannerOwned.projectTableCandidates
      : [];
    const mergedAcceptedRules = this._mergeRuleObjectsByName(existingAcceptedRules, acceptedRules);
    const mergedUnresolvedSignals = this._mergeUnresolvedSignals(existingUnresolvedSignals, unresolvedSignals);
    const mergedProjectTableCandidates = this._mergeProjectTableCandidates(existingProjectTableCandidates, projectTableCandidates);
    snapshot.plannerOwned.acceptedRules = mergedAcceptedRules;
    snapshot.plannerOwned.unresolvedSignals = mergedUnresolvedSignals;
    snapshot.plannerOwned.projectTableCandidates = mergedProjectTableCandidates;
    snapshot.updatedAt = new Date().toISOString();
    snapshot.outputDir = outputDir;
    try {
      this._ensureDir(outputDir);
      fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf-8');
    } catch (_) {
      // 写盘失败不应中断 rule_expert 主流程，AI 仍能看到响应文本。
    }
  }

  _mergeRuleObjectsByName(existing = [], incoming = []) {
    const byName = new Map();
    const keyFor = (rule = {}) => String(rule && (rule.ruleName || rule.resolvedRuleName || rule.ruleAlias) || '').trim();
    (Array.isArray(existing) ? existing : []).forEach(rule => {
      const key = keyFor(rule);
      if (key) byName.set(key, rule);
    });
    (Array.isArray(incoming) ? incoming : []).forEach(rule => {
      const key = keyFor(rule);
      if (key) byName.set(key, { ...(byName.get(key) || {}), ...rule });
    });
    return Array.from(byName.values());
  }

  _mergeUnresolvedSignals(existing = [], incoming = []) {
    const byKey = new Map();
    const keyFor = (item = {}) => [
      item && item.signal,
      item && item.userAnchor,
      item && item.description,
      item && item.reason
    ].map(value => String(value || '').trim()).filter(Boolean).join('|');
    (Array.isArray(existing) ? existing : []).forEach(item => {
      const key = keyFor(item);
      if (key) byKey.set(key, item);
    });
    (Array.isArray(incoming) ? incoming : []).forEach(item => {
      const key = keyFor(item);
      if (key) byKey.set(key, { ...(byKey.get(key) || {}), ...item });
    });
    return Array.from(byKey.values());
  }

  _requirementRulePoolUnresolvedSignals(summary = {}) {
    const byKey = new Map();
    const entries = Array.isArray(summary && summary.storyRuleRecalls) ? summary.storyRuleRecalls : [];
    entries.forEach(entry => {
      const storyId = String(entry && entry.storyId || '').trim();
      const userStory = String(entry && entry.userStory || '').trim();
      (Array.isArray(entry && entry.unresolvedSignals) ? entry.unresolvedSignals : []).forEach(item => {
        const signal = String(item && item.signal || '').trim();
        const userAnchor = String(item && item.userAnchor || '').trim();
        const usageDuty = String(item && item.usageDuty || '').trim();
        const reason = String(item && item.reason || '').trim();
        const fallbackKey = [userAnchor, usageDuty, reason].filter(Boolean).join('|');
        const key = signal || fallbackKey;
        if (!key) return;
        const current = byKey.get(key) || {
          signal,
          userAnchor,
          usageDuty,
          reason,
          source: String(item && item.source || '').trim(),
          storyIds: [],
          userStories: []
        };
        if (storyId && !current.storyIds.includes(storyId)) current.storyIds.push(storyId);
        if (userStory && !current.userStories.includes(userStory)) current.userStories.push(userStory);
        if (!current.signal && signal) current.signal = signal;
        if (!current.userAnchor && userAnchor) current.userAnchor = userAnchor;
        if (!current.usageDuty && usageDuty) current.usageDuty = usageDuty;
        if (!current.reason && reason) current.reason = reason;
        byKey.set(key, current);
      });
    });
    return Array.from(byKey.values()).slice(0, 12);
  }

  _mergeProjectTableCandidates(existing = [], incoming = []) {
    const byKey = new Map();
    const keyFor = (item = {}) => [
      item && item.tableName,
      item && item.entityName
    ].map(value => String(value || '').trim().toLowerCase()).filter(Boolean).join('|');
    (Array.isArray(existing) ? existing : []).forEach(item => {
      const key = keyFor(item);
      if (key) byKey.set(key, item);
    });
    (Array.isArray(incoming) ? incoming : []).forEach(item => {
      const key = keyFor(item);
      if (!key) return;
      const current = byKey.get(key) || {};
      byKey.set(key, {
        ...current,
        ...item,
        matchedTerms: Array.from(new Set([
          ...(Array.isArray(current.matchedTerms) ? current.matchedTerms : []),
          ...(Array.isArray(item.matchedTerms) ? item.matchedTerms : [])
        ].map(value => String(value || '').trim()).filter(Boolean))).slice(0, 12)
      });
    });
    return Array.from(byKey.values())
      .sort((a, b) =>
        Number(b.score || 0) - Number(a.score || 0)
        || String(a.tableName || a.entityName || '').localeCompare(String(b.tableName || b.entityName || ''), 'zh-Hans-CN')
      )
      .slice(0, 20);
  }

  _ruleIdentityKeys(item = {}) {
    if (typeof item === 'string') {
      return this._ruleIdentityKeyVariants(item);
    }
    if (!item || typeof item !== 'object') {
      return [];
    }
    const keys = [item.ruleName, item.ruleAlias, item.resolvedRuleName, item.name, item.title, item.path, item.filePath]
      .flatMap(value => this._ruleIdentityKeyVariants(value));
    return [...new Set(keys)];
  }

  _ruleIdentityKeyVariants(value = '') {
    const raw = String(value || '').trim();
    if (!raw) return [];
    const normalized = raw.replace(/\\/g, '/').replace(/\.mdc$/iu, '').toLowerCase();
    const segments = normalized.split('/').filter(Boolean);
    const basename = segments.length > 0 ? segments[segments.length - 1] : normalized;
    return [...new Set([normalized, basename].filter(Boolean))];
  }

  _rulesIdentityMatch(left = {}, right = {}) {
    const leftKeys = new Set(this._ruleIdentityKeys(left));
    if (leftKeys.size === 0) return false;
    return this._ruleIdentityKeys(right).some(key => leftKeys.has(key));
  }

  _extractRuleObligations(content = '', maxCount = 12) {
    const seen = new Set();
    const obligations = [];
    String(content || '')
      .replace(/^---[\s\S]*?---\s*/, '')
      .split(/\r?\n/)
      .map(line => line.replace(/^[\s>*#\-+`|0-9.、]+/, '').replace(/\s+/g, ' ').trim())
      .filter(line => line && !/^[-:|]+$/.test(line))
      .forEach(line => {
        if (!/(必须|禁止|严禁|不得|需要|应当|应|推荐|统一|优先|must|required|forbidden|should)/i.test(line)) return;
        const normalized = line.slice(0, 180);
        if (seen.has(normalized)) return;
        seen.add(normalized);
        obligations.push(normalized);
      });
    return obligations.slice(0, maxCount);
  }

  _compactGateContractResult(result = {}) {
    const contract = result.gateContract || {};
    const authoringSchema = contract.authoringSchema || (contract.constructionPlanContract && contract.constructionPlanContract.sections && contract.constructionPlanContract.sections.authoring) || {};
    const constructionPlanContract = contract.constructionPlanContract || {};
    const isFound = result.ok === true && result.status === 'found';
    // not_found 时直接透传引导字段，让 LLM 第一屏就看到 actionMode / expectedEntryTool /
    // allowedNextActions（AGENTS.md 行动锚点要求）。瘦身只对 found 时才剥离合同细节。
    if (!isFound) {
      const compact = {
        ok: false,
        status: result.status || 'not_found',
        slim: true
      };
      if (result.actionMode) compact.actionMode = result.actionMode;
      if (result.message) compact.message = result.message;
      if (result.query) compact.query = result.query;
      if (result.expectedEntryTool) compact.expectedEntryTool = result.expectedEntryTool;
      if (Array.isArray(result.allowedNextActions) && result.allowedNextActions.length > 0) {
        compact.allowedNextActions = result.allowedNextActions;
      }
      if (Array.isArray(result.forbiddenActions) && result.forbiddenActions.length > 0) {
        compact.forbiddenActions = result.forbiddenActions;
      }
      return compact;
    }
    return {
      ok: result.ok === true,
      status: result.status || '',
      slim: true,
      gateContract: {
        contractId: contract.contractId,
        version: contract.version,
        businessKey: contract.businessKey,
        stageKey: contract.stageKey,
        artifactKind: contract.artifactKind,
        gateId: contract.gateId,
        profile: contract.profile,
        summary: contract.summary,
        sourcePolicy: contract.sourcePolicy || null,
        authoringObligations: {
          beforeWriteOrder: Array.isArray(contract.authoringObligations && contract.authoringObligations.beforeWriteOrder)
            ? contract.authoringObligations.beforeWriteOrder.map(item => ({
                obligationId: item.obligationId,
                mustDo: item.mustDo,
                outputPaths: item.outputPaths,
                blocksIfMissing: item.blocksIfMissing,
                warnsIfMissing: item.warnsIfMissing
              }))
            : [],
          forbiddenAuthoringShortcuts: contract.authoringObligations && contract.authoringObligations.forbiddenAuthoringShortcuts || []
        },
        authoringSchema: {
          plannerOwned: authoringSchema.plannerOwned || [],
          requiredPlannerSlots: authoringSchema.requiredPlannerSlots || [],
          requiredBeforeFormalSubmit: Array.isArray(authoringSchema.requiredBeforeFormalSubmit)
            ? authoringSchema.requiredBeforeFormalSubmit.map(item => ({
                stepId: item.stepId,
                title: item.title,
                fillSlots: item.fillSlots,
                passWhen: item.passWhen,
                ifMissing: item.ifMissing,
                formalSubmitPolicy: item.formalSubmitPolicy
              }))
            : []
        },
        constructionPlanContract: {
          contractId: constructionPlanContract.contractId,
          version: constructionPlanContract.version,
          requiredSections: constructionPlanContract.schema && constructionPlanContract.schema.requiredSections || [],
          states: constructionPlanContract.states || {}
        }
      },
      fullContractAvailable: '调用 gate_contract 时传 outputMode=full 可返回完整合同。'
    };
  }

  _formatProjectScanArtifacts(globalPaths = {}, apiPaths = {}, bucketResult = {}) {
    const lines = [
      `- 项目现状报告：\`${globalPaths.scanReportPath || '未生成'}\``,
      `- 工程导航契约：\`${globalPaths.navigationContractPath || '未生成'}\``,
      `- 工程导航契约 JSON：\`${globalPaths.navigationContractJsonPath || '未生成'}\``,
      `- 工程导航契约 compact：\`${globalPaths.navigationContractCompactPath || '未生成'}\``,
      `- 框架版本档位：\`${bucketResult.path || globalPaths.frameworkBucketPath || '未生成'}\``
    ];
    if (apiPaths && apiPaths.ruleDir) {
      lines.push(`- 项目 API 资产目录：\`${apiPaths.ruleDir}\``);
    }
    if (globalPaths.assetIndexPath) {
      lines.push(`- 资产索引：\`${globalPaths.assetIndexPath}\``);
    }
    if (globalPaths.businessGraphPath) {
      lines.push(`- 业务图谱：\`${globalPaths.businessGraphPath}\``);
    }
    return lines.join('\n');
  }

  _formatProjectScanArtifactExistence(globalPaths = {}) {
    const format = (label, filePath) => {
      if (!filePath) return `- ${label}：未解析路径`;
      return `- ${label}：${fs.existsSync(filePath) ? '已存在' : '缺失'} \`${filePath}\``;
    };
    return [
      format('项目现状报告', globalPaths.scanReportPath),
      format('工程导航契约', globalPaths.navigationContractPath),
      format('工程导航契约 JSON', globalPaths.navigationContractJsonPath),
      format('工程导航契约 compact', globalPaths.navigationContractCompactPath),
      format('框架版本档位', globalPaths.frameworkBucketPath),
      format('资产索引', globalPaths.assetIndexPath),
      format('业务图谱', globalPaths.businessGraphPath)
    ].join('\n');
  }

  async _handleProjectScan(args = {}) {
    const projectPath = String(args.projectPath || '').trim();
    const userIntent = String(args.userIntent || '').trim();
    if (!projectPath) {
      return '⛔ PROJECT_SCAN_PROJECT_PATH_REQUIRED: 请提供 projectPath。';
    }
    if (!fs.existsSync(projectPath)) {
      return `⛔ PROJECT_SCAN_PROJECT_PATH_NOT_FOUND: ${projectPath}`;
    }

    const artifactPath = PipelineUtils.getProjectStructureDir(projectPath);
    const globalPathsBeforeScan = this.projectScanService.getProjectStructurePaths(projectPath);
    const forceRefresh = this.projectScanService.isForceRefreshScan(userIntent);
    if (!forceRefresh && globalPathsBeforeScan.scanReportPath && fs.existsSync(globalPathsBeforeScan.scanReportPath)) {
      return [
        '# 项目级勘测已复用',
        '',
        '检测到项目级 `项目现状报告.md` 已存在，本次不重新扫描项目，避免重复消耗资源。',
        '',
        '## 本次处理结果',
        `- 项目路径：\`${projectPath}\``,
        '- 处理方式：命中已有项目现状报告，跳过 baseline scan。',
        `- 项目级基线目录：\`${globalPathsBeforeScan.structureDir || artifactPath}\``,
        '',
        '## 项目级产物状态',
        this._formatProjectScanArtifactExistence(globalPathsBeforeScan),
        '',
        '## 下游使用约定',
        '- 需求施工 skill 读取 `工程导航契约.compact.json` 生成代码坐落点和 allowedFileScope。',
        '- 如果工程导航契约或 compact 缺失，下游应阻断并提示显式刷新 scan。',
        '- 如需刷新工程事实，请再次调用 `project_scan` 并在 userIntent 中说明“刷新基线/重新勘测”。'
      ].join('\n');
    }

    const baselineResult = this.projectScanService.prepareArtifacts(projectPath, artifactPath, userIntent);
    if (!baselineResult.ok) {
      return baselineResult.message || '⛔ PROJECT_SCAN_FAILED: 项目级勘测失败。';
    }

    const globalPaths = baselineResult.globalPaths || this.projectScanService.getProjectStructurePaths(projectPath);
    const apiPaths = baselineResult.apiPaths || this.projectScanService.getProjectApiCatalogPaths(projectPath);
    const bucketResult = this.projectScanService.prepareFrameworkVersionBucket(projectPath, userIntent);
    const sourceTextMap = {
      'global-cache': '命中已有项目级勘测真值，本次直接复用。',
      rebuilt: '未命中可用项目级基线，已重新执行勘测并写回项目级真值。',
      'forced-refresh': '检测到刷新指令，已强制重跑勘测并覆盖项目级真值。'
    };
    const bucketLine = bucketResult.ok
      ? `- 框架档位：\`${bucketResult.versionBucket}\`（source=${bucketResult.source || bucketResult.bucketSource || 'unknown'}）`
      : [
        '- 框架档位：未确认',
        `- 缺口：${bucketResult.message || 'FRAMEWORK_VERSION_BUCKET_MISSING'}`,
        `- 可选值：${Array.isArray(bucketResult.options) ? bucketResult.options.map(item => `\`${item}\``).join(' / ') : '`950及以上` / `950以下`'}`,
        '- 处理方式：重新调用 `project_scan`，在 userIntent 中补充 `950及以上` 或 `950以下`。'
      ].join('\n');
    const apiLine = baselineResult.apiCatalogState && baselineResult.apiCatalogState.ok
      ? (baselineResult.apiCatalogState.empty ? '- 项目 API 资产：为空（允许）' : '- 项目 API 资产：已校验')
      : `- 项目 API 资产：${baselineResult.apiCatalogState && baselineResult.apiCatalogState.message || '未校验'}`;
    const graphWarnings = Array.isArray(baselineResult.graphEnhancementWarnings) && baselineResult.graphEnhancementWarnings.length > 0
      ? `\n\n## 轻量增强警告\n${baselineResult.graphEnhancementWarnings.map(item => `- ${item}`).join('\n')}`
      : '';

    return [
      '# 项目级勘测完成',
      '',
      '本工具是独立 scan 入口，只产出项目级工程事实，不创建流水线计划，不推进 requirement/design/code。',
      '',
      '## 本次处理结果',
      `- 项目路径：\`${projectPath}\``,
      `- 处理方式：${sourceTextMap[baselineResult.source] || baselineResult.source || '已准备项目级勘测产物'}`,
      `- 项目级基线目录：\`${globalPaths.structureDir || artifactPath}\``,
      bucketLine,
      apiLine,
      '',
      '## 项目级产物',
      this._formatProjectScanArtifacts(globalPaths, apiPaths, bucketResult),
      graphWarnings,
      '',
      '## 下游使用约定',
      '- 需求施工 skill 读取 `工程导航契约.compact.json` 生成代码坐落点和 allowedFileScope。',
      '- coder skill 只消费施工单里的 allowedFileScope，不重新搜索工程补路径。',
      '- 如需刷新工程事实，请再次调用 `project_scan` 并在 userIntent 中说明“刷新基线/重新勘测”。'
    ].join('\n');
  }

  /**
   * 工具名归一化：剥离 IDE 客户端可能加的命名空间前缀。
   *
   * 不同 IDE 客户端给工具名加不同前缀；服务端必须统一剥离回纯工具名，
   * 否则 case 分支命中失败，LLM 会以为"工具不存在"然后去 file_search。
   *
   * 已知形态：
   *   - 'epoint-project-rules/list_rules'         （路径风格）
   *   - 'epoint-project-rules\\list_rules'        （Windows 路径风格）
   *   - 'epoint-project-rules.design_prepare_context'      （点号命名空间）
   *   - 'mcp_epoint-project-rules_design_prepare_context' （IDE 把 mcp_<server>_ 拼进工具名）
   *
   * 策略：
   *   1. 路径/点号分隔符：取最后一段
   *   2. mcp_ 前缀 + 已知 server 名：精确匹配 'mcp_<server>_' 前缀，剥离后剩下的就是工具名
   *
   * 不做模糊匹配（比如纯 startsWith 'mcp_'）以避免误吃合法工具名（虽然当前没有以 mcp_ 开头的工具，
   * 但保留严格性方便审计）。
   */
  _normalizeMcpToolName(name) {
    if (typeof name !== 'string' || !name) return name;
    let normalized = name.trim();

    // ① 路径分隔符：'epoint-project-rules/list_rules' → 'list_rules'
    if (normalized.includes('/') || normalized.includes('\\')) {
      const parts = normalized.split(/[/\\]/);
      normalized = parts[parts.length - 1];
    }

    // ② 点号命名空间：'epoint-project-rules.design_prepare_context' → 'design_prepare_context'
    if (normalized.includes('.')) {
      const parts = normalized.split('.');
      normalized = parts[parts.length - 1];
    }

    // ③ IDE 'mcp_<server>_<tool>' 命名空间前缀
    // 已知 server 名只有 'epoint-project-rules'。直接精确剥离。
    const KNOWN_SERVER_PREFIXES = ['mcp_epoint-project-rules_', 'mcp.epoint-project-rules.'];
    for (const prefix of KNOWN_SERVER_PREFIXES) {
      if (normalized.startsWith(prefix)) {
        normalized = normalized.slice(prefix.length);
        break;
      }
    }

    return normalized;
  }

  /**
   * IDE 客户端 stringified-arguments wrapper 解包。
   *
   * 故事线：Trae 的 run_mcp 包装器在调用 MCP 工具时，会把整个 arguments 对象
   * JSON.stringify 一次塞进单个名叫 `args` 的字符串字段里发给桥接层，形态如：
   *   { args: '{"projectPath":"d:\\\\...","decisionRows":[...],...}' }
   * 桥接层只 parse 到外壳就交给 server，server 收到的 arguments 就是单字段
   * string wrapper。设计阶段对行数组入参严格校验(Array.isArray)，落到这种形态
   * 必然 blocked，但 LLM 看不到 IDE 这层 bug，会反复重试同一个错误调用。
   *
   * 修法：单字段 + 字段名是 args + 值是 string + 看起来像 JSON object 时，
   * 解开 wrapper 还原成真正的 arguments 对象；其它一切形态原样返回，避免误伤。
   * 这一层只解外壳，字段级二次 stringify 由 _coerceStringifiedJsonValueArgs 处理。
   */
  _unwrapStringifiedArguments(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return args || {};
    const keys = Object.keys(args);
    if (keys.length !== 1 || keys[0] !== 'args') return args;
    const raw = args.args;
    if (typeof raw !== 'string') return args;
    const trimmed = raw.trim();
    if (!(trimmed.startsWith('{') && trimmed.endsWith('}'))) return args;
    try {
      const unwrapped = JSON.parse(trimmed);
      if (unwrapped && typeof unwrapped === 'object' && !Array.isArray(unwrapped)) {
        console.error('[MCP Debug] Detected stringified arguments wrapper, unwrapped successfully.');
        unwrapped.__mcpArgumentsWrapperUnwrapped = true;
        return unwrapped;
      }
    } catch (_) {
      // 不是合法 JSON 就保持原样，下游 audit/blocked 会让 LLM 看到错误形态
    }
    return args;
  }

  /**
   * 字段级 stringified-JSON 反序列化兜底。
   *
   * 故事线：除整对象 wrapper 外，部分客户端只把 array/object 字段单独 stringify，
   * 形态如 { decisionRows: "[\"TABLE|...\"]" }。
   * 服务端按 Array.isArray 严格校验时同样会 blocked。
   *
   * 这里按工具名维护"会传 array/object 的字段清单"，仅对清单内字段做 JSON.parse
   * 还原；不在清单内的字段一律保留原值，避免把业务字符串误 parse。修复结果通过
   * args.__mcpStringifiedFieldsCoerced 暴露给下游 audit。
   */
  _coerceStringifiedJsonValueArgs(toolName, args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
    const ARRAY_OR_OBJECT_FIELDS_BY_TOOL = {
      design_prepare_context: [
        'decisionRows', 'detailRows', 'compositionRows'
      ],
      req_rule_decision_submit: ['keptRuleAliases'],
      req_table_decision_submit: ['keptTableNames'],
      rule_expert: ['params', 'parameters']
    };
    const fields = ARRAY_OR_OBJECT_FIELDS_BY_TOOL[toolName];
    if (!Array.isArray(fields) || fields.length === 0) return args;

    const out = { ...args };
    const coerced = [];
    for (const key of fields) {
      const pathParts = String(key || '').split('.').filter(Boolean);
      if (pathParts.length === 0) continue;
      let owner = out;
      for (let i = 0; i < pathParts.length - 1; i++) {
        owner = owner && typeof owner === 'object' && !Array.isArray(owner) ? owner[pathParts[i]] : null;
      }
      if (!owner || typeof owner !== 'object' || Array.isArray(owner)) continue;
      const leafKey = pathParts[pathParts.length - 1];
      const v = owner[leafKey];
      if (typeof v !== 'string') continue;
      const trimmed = v.trim();
      if (!(trimmed.startsWith('[') || trimmed.startsWith('{'))) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && (Array.isArray(parsed) || typeof parsed === 'object')) {
          owner[leafKey] = parsed;
          coerced.push(key);
        }
      } catch (_) {
        // 解析失败保留原值；下游 isArray=false 的 audit 会让 LLM 看到错误形态
      }
    }
    if (coerced.length > 0) {
      console.error(`[MCP Debug] Coerced stringified JSON fields back to value for ${toolName}: ${coerced.join(', ')}`);
      out.__mcpStringifiedFieldsCoerced = coerced;
    }
    return out;
  }

  /**
   * 第三层 IDE 入参兜底：把 array 字段被包成 { item: [...] } / { items: [...] } 的形态展开为裸 array。
   *
   * 故事线：除前两层（整对象 wrapper、字段级字符串化）外，还观察到 Trae 的 run_mcp 包装器把
   * array 入参进一步包成 { item: [...] }。
   *
   * 已知容器键名：item / items / value / values / list / array / data；其它键名不展开，
   * 避免误把业务对象当成 array 容器。展开规则：
   *   ① 字段是 plain object（非数组）
   *   ② 仅一个键，且键名在 KNOWN_ARRAY_CONTAINER_KEYS 内
   *   ③ 该键的值是 array
   * 三条同时满足才展开为裸 array；任何条件不满足保留原值，下游 audit 会让 LLM 看到。
   */
  _unwrapArrayLikeObjectArgs(toolName, args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
    const ARRAY_OR_OBJECT_FIELDS_BY_TOOL = {
      design_prepare_context: [
        'decisionRows', 'detailRows', 'compositionRows'
      ],
      req_rule_decision_submit: ['keptRuleAliases'],
      req_table_decision_submit: ['keptTableNames']
    };
    const fields = ARRAY_OR_OBJECT_FIELDS_BY_TOOL[toolName];
    if (!Array.isArray(fields) || fields.length === 0) return args;

    const KNOWN_ARRAY_CONTAINER_KEYS = new Set(['item', 'items', 'value', 'values', 'list', 'array', 'data', 'entries']);
    const out = { ...args };
    const unwrapped = [];
    for (const key of fields) {
      const pathParts = String(key || '').split('.').filter(Boolean);
      if (pathParts.length === 0) continue;
      let owner = out;
      for (let i = 0; i < pathParts.length - 1; i++) {
        owner = owner && typeof owner === 'object' && !Array.isArray(owner) ? owner[pathParts[i]] : null;
      }
      if (!owner || typeof owner !== 'object' || Array.isArray(owner)) continue;
      const leafKey = pathParts[pathParts.length - 1];
      const v = owner[leafKey];
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
      const innerKeys = Object.keys(v);
      if (innerKeys.length !== 1) continue;
      const innerKey = innerKeys[0];
      if (!KNOWN_ARRAY_CONTAINER_KEYS.has(innerKey.toLowerCase())) continue;
      const innerValue = v[innerKey];
      if (Array.isArray(innerValue)) {
        // 标准形态：{item: [...]}
        owner[leafKey] = innerValue;
        unwrapped.push(`${key} <- {${innerKey}:[...]}`);
      } else if (innerValue && typeof innerValue === 'object') {
        // 单元素退化形态：{item: {...}} —— 某些 IDE（已观察到 Trae）在 array 只有 1 个
        // 元素时把元素从数组里"剥"出来，这是 XML→JSON 转换器的常见行为。
        // 包成单元素数组让下游的 Array.isArray 校验过得去。
        owner[leafKey] = [innerValue];
        unwrapped.push(`${key} <- {${innerKey}:{singleElem}}`);
      }
      // 内部值是基本类型时不展开，保持原样让下游 audit 报错
    }
    if (unwrapped.length > 0) {
      console.error(`[MCP Debug] Unwrapped array-like object args for ${toolName}: ${unwrapped.join(', ')}`);
      out.__mcpArrayLikeObjectsUnwrapped = unwrapped;
    }
    return out;
  }

  /**
   * design_prepare_context 的受管 Builder 收口逻辑。
   *
   * 故事线：LLM 在长对话末尾调"陌生工具名"会陷入 file_search 真空。design_prepare_context
   * 是唯一公开入口；本方法只消费DesignModelCompiler受管投影，不接收旧路线payload。
   */
  async _finalizeCanonicalDesignWorkflow({ resolved, builderInput, canonicalModel }) {
    const response = await this._dispatchCanonicalDesignFinalize({
      projectPath: resolved.projectPath,
      skillName: 'epoint-requirement-design',
      entityJudgments: builderInput.entityJudgments,
      tableCandidateFitDecisions: builderInput.tableCandidateFitDecisions,
      allowSharedStoryIds: builderInput.allowSharedStoryIds === true,
      managedProjection: builderInput.managedProjection === true,
      canonicalModel,
      __designPrepareContextDispatch: true,
      __canonicalWorkflowDispatch: true
    }, null);
    let payload = null;
    try {
      payload = JSON.parse(response && response.content && response.content[0] && response.content[0].text || '{}');
    } catch (_) {
      payload = null;
    }
    if (!payload || payload.ok !== true || payload.designFinalized !== true) {
      return payload || {
        ok: false,
        errorCode: 'DESIGN_CANONICAL_FINALIZE_RESPONSE_INVALID',
        message: '最终Builder返回不可解析结果。'
      };
    }
    const existingPlanPath = path.join(resolved.demandDir, 'code', 'design-tdd-plan.json');
    if (fs.existsSync(existingPlanPath)) {
      const sync = this.designTddPlanService.buildPlan({ projectPath: resolved.projectPath });
      if (!sync.ok) return { ...sync, designFinalized: true, downstreamSyncPending: true,
        message: `设计已保存，后续施工资料尚未同步：${sync.message || sync.errorCode}` };
    }
    return {
      ...payload,
      finalizeReceiptRef: resolved.finalizeReceiptPath
    };
  }

  async _dispatchCanonicalDesignFinalize(args, request) {
    const skillNameRequired = this._requireSkillNameForTool('design_prepare_context', args);
    if (skillNameRequired) return skillNameRequired;
    const projectPath = String(args.projectPath || '').trim();
    if (!projectPath) {
      return { content: [{ type: "text", text: JSON.stringify({ ok: false, status: "blocked", message: "缺少 projectPath 参数" }) }], isError: true };
    }
    if (args.__canonicalWorkflowDispatch !== true
      || args.managedProjection !== true
      || !args.canonicalModel
      || args.canonicalModel.schemaVersion !== 'design-canonical-model/v1') {
      return this._designPrepareContextToolResponse({
        ok: false,
        status: 'blocked',
        actionMode: 'use_design_prepare_context_only',
        errorCode: 'DESIGN_INTERNAL_CANONICAL_PROJECTION_REQUIRED',
        message: '最终Builder只接受DesignModelCompiler受管投影；重新无phase调用design_prepare_context恢复。',
        allowedNextActions: ['call_design_prepare_context_without_phase'],
        forbiddenActions: ['submit_legacy_design_payload', 'write_design_document_json_directly']
      });
    }

    let designJson = null;
    const designRepairActions = ['report_design_projection_defect'];

    const designPathsForBuilder = this._resolveActiveDemandDesignPaths(projectPath);
    if (!designPathsForBuilder.ok) {
      return this._designPrepareContextToolResponse({ ok: false, status: "blocked", actionMode: "upstream_design_repair", errorCode: designPathsForBuilder.errorCode, message: designPathsForBuilder.message, activeDemandPath: designPathsForBuilder.activeDemandPath, allowedNextActions: ['restore_active_demand_then_rerun_design_prepare_context'], forbiddenActions: ['write_design_document_json_directly'] });
    }
    // 上游 stories.json 是必需事实；缺失就 blocked，让 LLM 回需求阶段补齐
    const storiesValidation = this.requirementStoriesBuilderService.validateSubmitReceipt({
      projectPath,
      storiesPath: designPathsForBuilder.requirementStoriesPath,
      storiesReceiptPath: designPathsForBuilder.requirementStoriesReceiptPath,
      analysisStatePath: designPathsForBuilder.requirementAnalysisStatePath
    });
    if (!storiesValidation.ok) {
      return this._designPrepareContextToolResponse({
        ok: false,
        status: "blocked",
        actionMode: "rerun_req_stories_submit_in_analyzer",
        errorCode: storiesValidation.code,
        message: storiesValidation.message,
        issues: storiesValidation.issues || [],
        nextActionCard: storiesValidation.nextActionCard,
        allowedNextActions: ['rerun_req_stories_submit_in_analyzer_then_rerun_design_prepare_context'],
        forbiddenActions: ['write_stories_json_directly', 'write_design_document_json_directly']
      });
    }
    const navigationForBuilder = this._readNavigationContractForDesignPreflight(projectPath);
    if (!navigationForBuilder.ok) {
      return this._designPrepareContextToolResponse({ ok: false, status: "blocked", actionMode: "upstream_design_repair", errorCode: navigationForBuilder.errorCode, message: navigationForBuilder.message, sourcePath: navigationForBuilder.sourcePath, allowedNextActions: ['repair_scan_navigation_contract_then_rerun_design_prepare_context'], forbiddenActions: ['write_design_document_json_directly'] });
    }
    const rulePoolReceiptValidation = this.requirementRulePoolBuilderService.validateSubmitReceipt({
      rulePoolPath: designPathsForBuilder.requirementRulePoolPath,
      receiptPath: path.join(path.dirname(designPathsForBuilder.requirementRulePoolPath), 'rule-pool-submit-receipt.json')
    });
    if (!rulePoolReceiptValidation.ok) {
      return this._designPrepareContextToolResponse({
        ok: false,
        status: "blocked",
        actionMode: "rerun_requirement_rule_pool_in_analyzer",
        errorCode: rulePoolReceiptValidation.code,
        message: rulePoolReceiptValidation.message,
        allowedNextActions: ['rerun_requirement_rule_pool_in_analyzer_then_rerun_design_prepare_context'],
        forbiddenActions: ['write_rule_pool_json_directly', 'write_design_document_json_directly']
      });
    }
    const requirementRulePoolReadForBuilder = this._readJsonIfExists(designPathsForBuilder.requirementRulePoolPath);
    const confirmedRequirementRulePool = requirementRulePoolReadForBuilder.ok ? requirementRulePoolReadForBuilder.value : null;
    // 读 entity-graph 用于 reuse 表反查 sourceFile（Builder 自动给 Coder 提供复用代码物理路径）
    const entityGraphPath = path.join(designPathsForBuilder.projectArtifactsDir, 'entity-graph.json');
    const entityGraphRead = this._readJsonIfExists(entityGraphPath);
    const entityGraph = entityGraphRead.ok ? entityGraphRead.value : null;
    const builderArgs = {};
    if (Array.isArray(args.entityJudgments)) builderArgs.entityJudgments = args.entityJudgments;
    if (Object.prototype.hasOwnProperty.call(args || {}, 'tableCandidateFitDecisions')) {
      builderArgs.tableCandidateFitDecisions = args.tableCandidateFitDecisions;
    }
    if (args.__canonicalWorkflowDispatch === true) {
      builderArgs.allowSharedStoryIds = args.allowSharedStoryIds === true;
      builderArgs.managedProjection = args.managedProjection === true;
      builderArgs.canonicalModel = args.canonicalModel;
    }
    const buildResult = this.designDocumentBuilderService.build(
      builderArgs,
      {
        demandName: designPathsForBuilder.demandName,
        navigationContract: navigationForBuilder.value || {},
        confirmedRequirementRulePool,
        requirementStories: storiesValidation.stories,
        entityGraph
      }
    );
    if (!buildResult.ok) {
      return this._designPrepareContextToolResponse({
        ok: false,
        status: "blocked",
        actionMode: "report_design_projection_defect",
        errorCode: 'DESIGN_PUBLIC_INPUT_PROJECTION_DEFECT',
        message: 'Canonical公开输入已经通过，最终Builder却拒绝机械投影；这是系统合同缺陷，不要求LLM重答业务。',
        issues: buildResult.issues || [],
        allowedNextActions: ['report_design_projection_defect'],
        forbiddenActions: ['repair_business_answer', 'write_design_document_json_directly']
      });
    }
    designJson = buildResult.designJson;

    const designPaths = this._resolveActiveDemandDesignPaths(projectPath);
    if (!designPaths.ok) {
      return this._designPrepareContextToolResponse({ ok: false, status: "blocked", actionMode: "upstream_design_repair", errorCode: designPaths.errorCode, message: designPaths.message, activeDemandPath: designPaths.activeDemandPath, allowedNextActions: ['restore_active_demand_then_rerun_design_prepare_context'], forbiddenActions: ['write_design_document_json_directly'] });
    }

    // --- Preflight 阶段 ---
    const receiptPath = designPaths.receiptPath;

    const navigation = this._readNavigationContractForDesignPreflight(projectPath);
    if (!navigation.ok) {
      return this._designPrepareContextToolResponse({ ok: false, status: "blocked", actionMode: "upstream_design_repair", errorCode: navigation.errorCode, message: navigation.message, sourcePath: navigation.sourcePath, allowedNextActions: ['repair_scan_navigation_contract_then_rerun_design_prepare_context'], forbiddenActions: ['write_design_document_json_directly'] });
    }

    const schemaResult = this.designSchemaValidatorService.validateSchema(designJson);
    if (!schemaResult.ok) {
      const compactSchemaLayer = schemaResult.schemaLayer.compact || schemaResult.schemaLayer;
      return this._designPrepareContextToolResponse({ ok: false, status: "schema_blocked", actionMode: 'report_design_projection_defect', errorCode: 'SCHEMA_LAYER_VALIDATION_FAILED', schemaLayer: compactSchemaLayer, message: 'Canonical投影未通过最终Schema层；这是系统投影缺陷，不要求LLM修改当前业务答案。', allowedNextActions: designRepairActions, forbiddenActions: ['repair_business_answer', 'write_design_document_json_directly'] });
    }

    const machineDesignJson = this.designSchemaValidatorService.normalizeMachineJson(designJson);

    const databaseNamingResult = this.designDatabaseNamingValidatorService.validateDatabaseNaming(machineDesignJson, navigation.value || {});
    if (!databaseNamingResult.ok) {
      return this._designPrepareContextToolResponse({ ok: false, status: "database_naming_blocked", actionMode: 'report_design_projection_defect', errorCode: 'DATABASE_NAMING_LAYER_VALIDATION_FAILED', databaseNamingLayer: databaseNamingResult.databaseNamingLayer, message: 'Canonical投影未通过项目数据库命名合同；这是Builder机械命名缺陷，不要求LLM手填表名。', allowedNextActions: designRepairActions, forbiddenActions: ['repair_business_answer', 'write_design_document_json_directly'] });
    }

    const requirementRulePoolRead = this._readRequirementRulePoolForDesign(designPaths);
    const ruleBindingsForValidation = this._renderRuleBindingsFromRequirementRulePool(requirementRulePoolRead.value, designPaths);
    const ruleBindingResult = this._validateDesignRuleBindingClosure(machineDesignJson, ruleBindingsForValidation, '<builder-derived>');
    if (!ruleBindingResult.ok) {
      return this._designPrepareContextToolResponse(this._buildDesignRuleBindingBlockedResponse(ruleBindingResult));
    }
    const requirementPoolBindingResult = this._validateRuleBindingsAgainstRequirementPool(ruleBindingsForValidation, requirementRulePoolRead, designPaths);
    if (!requirementPoolBindingResult.ok) {
      return this._designPrepareContextToolResponse(this._buildRequirementRulePoolBlockedResponse(requirementPoolBindingResult));
    }

    const preflightResult = this.designCodingHandoffService.validateDesignHandoff(machineDesignJson, navigation.value || {});
    if (!preflightResult.ok) {
      return this._designPrepareContextToolResponse({ ...preflightResult, source: 'design_prepare_context', allowedNextActions: designRepairActions, forbiddenActions: ['write_design_document_json_directly', 'bypass_managed_design_workflow'] });
    }

    // --- Placement resolution ---
    const DesignPlacementResolverService = require('./modules/pipeline-support/design-placement-resolver-service');
    const placementResolver = new DesignPlacementResolverService();
    const placementResult = placementResolver.resolve(machineDesignJson, navigation.value || {});
    if (!placementResult.ok) {
      return this._designPrepareContextToolResponse({
        ...placementResult,
        source: 'design_prepare_context',
        allowedNextActions: designRepairActions
      });
    }
    if (Array.isArray(placementResult.resolvedEntities)) {
      for (const resolved of placementResult.resolvedEntities) {
        const entity = machineDesignJson.businessEntities.find(e => e.entityKey === resolved.entityKey);
        if (entity) {
          entity.resolvedFiles = resolved.resolvedFiles;
        }
      }
    }

    if (args.__canonicalWorkflowDispatch === true) {
      const coderPreflight = this.designTddPlanService.buildPlanWithDesign({
        projectPath,
        skillName: 'epoint-design-tdd-coder',
        writeToFile: false
      }, machineDesignJson);
      if (!coderPreflight || coderPreflight.ok !== true) {
        return this._designPrepareContextToolResponse({
          ok: false,
          status: 'blocked',
          actionMode: 'report_design_projection_defect',
          errorCode: 'DESIGN_CODER_BUILD_PLAN_PREFLIGHT_FAILED',
          message: 'Canonical model已通过公开合同，但真实Coder build plan无落盘预检失败；停止要求LLM修改业务答案。',
          preflight: coderPreflight,
          allowedNextActions: ['report_design_projection_defect'],
          forbiddenActions: ['repair_business_answer', 'write_design_document_json_directly']
        });
      }
      const constructionCoverage = this.designCoderConstructionCoverageService.validate({
        designDocument: machineDesignJson,
        coderPreflight
      });
      if (!constructionCoverage.ok) {
        return this._designPrepareContextToolResponse(constructionCoverage);
      }
    }

    // --- Finalize 阶段 ---
    let designMarkdown;
    let ruleRecallRaw;
    let ruleBindings;
    let designState = null;
    designMarkdown = this._renderDesignMarkdownFromDesignJson(machineDesignJson, requirementRulePoolRead.value || {});
    ruleRecallRaw = this._renderRuleRecallRawFromRequirementRulePool(requirementRulePoolRead.value || {}, designPaths);
    ruleBindings = this._renderRuleBindingsFromRequirementRulePool(requirementRulePoolRead.value || {}, designPaths);
    designState = {
      schemaVersion: 'design-state/v1',
      status: 'done',
      currentStep: 'completed',
      managedBy: 'design_document_builder',
      completedAt: new Date().toISOString()
    };

    const designHash = this._sha256(JSON.stringify(machineDesignJson));
    const ruleBindingsHash = this._hashRuleBindingsForDesign(ruleBindings);
    const receipt = { status: 'ready', ok: true, designHash, ruleBindingsHash, hashMode: 'machine_json_logical', demandName: designPaths.demandName, demandDir: designPaths.demandDir, designJsonPath: designPaths.designJsonPath, timestamp: new Date().toISOString() };

    const markdownPrepare = this._prepareFinalDesignMarkdown(designMarkdown, machineDesignJson, navigation.value || {});
    if (markdownPrepare.ok !== true) {
      return this._designPrepareContextToolResponse({ ...markdownPrepare, allowedNextActions: designRepairActions, forbiddenActions: ['write_design_document_json_directly', 'bypass_managed_design_workflow'] });
    }

    const finalizeReceiptPath = path.join(designPaths.designDir, 'design-finalize-receipt.json');
    const finalizeResult = this.managedArtifactFinalizerService.finalize({
      atomic: true,
      stageKey: 'requirement-design',
      actionMode: 'write_final_design_artifacts_by_fixed_paths',
      rootDir: designPaths.demandDir,
      receiptPath: finalizeReceiptPath,
      artifacts: [
        { key: 'designJson', type: 'json', path: designPaths.designJsonPath, payload: machineDesignJson, expectedHash: designHash, hashMode: 'json_logical', hashSource: JSON.stringify(machineDesignJson) },
        { key: 'designPreflight', type: 'json', path: receiptPath, payload: receipt },
        { key: 'designMarkdown', type: 'text', path: designPaths.designMarkdownPath, payload: markdownPrepare.markdown },
        { key: 'ruleRecallRaw', type: 'text', path: designPaths.ruleRecallRawPath, payload: ruleRecallRaw },
        { key: 'ruleBindings', type: 'json', path: designPaths.ruleBindingsPath, payload: ruleBindings },
        { key: 'designState', type: 'json', path: designPaths.designStatePath, payload: designState }
      ],
      receiptExtra: { preflightReceiptPath: receiptPath, demandName: designPaths.demandName, designHash, resolvedHtmlPages: markdownPrepare.resolvedHtmlPages || [] },
      allowedNextActions: ['confirm_design_artifacts_written_then_continue_to_tdd'],
      writeFailureNextActions: ['fix_design_directory_permission_then_rerun_design_prepare_context'],
      verifyFailureNextActions: ['rerun_design_prepare_context_phase_details_confirmed'],
      forbiddenActions: ['write_design_document_json_directly']
    });

    if (finalizeResult.ok !== true) {
      return this._designPrepareContextToolResponse({ ...finalizeResult, actionMode: finalizeResult.actionMode || 'upstream_design_repair', errorCode: finalizeResult.errorCode || 'DESIGN_SUBMIT_FINALIZE_FAILED', forbiddenActions: ['write_design_document_json_directly'] });
    }
    let finalLogicalHash = '';
    try {
      const finalSnapshot = JSON.parse(fs.readFileSync(designPaths.designJsonPath, 'utf-8'));
      finalLogicalHash = this._sha256(JSON.stringify(finalSnapshot));
    } catch (error) {
      try { if (fs.existsSync(finalizeReceiptPath)) fs.unlinkSync(finalizeReceiptPath); } catch (_) {}
      return this._designPrepareContextToolResponse({
        ok: false,
        status: 'blocked',
        actionMode: 'restore_design_after_finalize_interruption',
        errorCode: 'DESIGN_FINAL_SNAPSHOT_READ_FAILED',
        message: `最终设计快照反读失败：${error.message}`,
        allowedNextActions: ['rerun_current_design_finalize_step'],
        forbiddenActions: ['advance_to_coder']
      });
    }
    if (finalLogicalHash !== designHash) {
      try { if (fs.existsSync(finalizeReceiptPath)) fs.unlinkSync(finalizeReceiptPath); } catch (_) {}
      return this._designPrepareContextToolResponse({
        ok: false,
        status: 'blocked',
        actionMode: 'restore_design_after_finalize_interruption',
        errorCode: 'DESIGN_FINAL_LOGICAL_HASH_MISMATCH',
        message: '最终设计快照在投影、Placement、PageContract 和 Coder 预检后发生变化；finalize receipt 已撤销。',
        expectedHash: designHash,
        actualHash: finalLogicalHash,
        allowedNextActions: ['report_design_projection_defect'],
        forbiddenActions: ['advance_to_coder']
      });
    }

    const summary = this._buildFileOutputSummary(machineDesignJson);
    const continuation = this._buildDesignCompletionContinuation(machineDesignJson, designPaths, projectPath, summary);
    return {
      content: [{ type: "text", text: JSON.stringify({
        ok: true,
        status: 'ready',
        // 赌点9：单一权威完成信号。只有 designFinalized=true 才表示设计真正完成、
        // 5 产物已落盘、可进入下一阶段。其余 ok=true / status=ready / ready_for_details
        // 都是中间态，不构成完成。
        designFinalized: true,
        stage: 'final',
        actionMode: 'design_prepare_context_complete',
        source: 'design_prepare_context',
        ...continuation,
        finalizeReceipt: finalizeResult.receipt,
        receipt: finalizeResult.receipt
      }, null, 2) }],
      isError: false
    };
  }

  _projectDocumentationContinuation(payload = {}) {
    const nextAction = payload && payload.postDesignNextAction || {};
    const card = payload && payload.documentationTaskCard;
    const isSilent = nextAction.executionMode === 'silent_auto_continue'
      || Boolean(card && (payload.designFinalized === true || payload.implementationStatus === 'completed'));
    const originalText = JSON.stringify(payload, null, 2);
    const originalBytes = Buffer.byteLength(originalText, 'utf8');
    if (!isSilent && originalBytes <= MAX_CONTINUATION_RESPONSE_BYTES) return payload;

    const omittedFields = [];
    const projected = { ...payload };
    if (card && card.documentationTaskCardRef && !projected.documentationTaskCardRef) {
      projected.documentationTaskCardRef = card.documentationTaskCardRef;
    }
    if (card && card.deliveryFactsRef && !projected.deliveryFactsRef) {
      projected.deliveryFactsRef = card.deliveryFactsRef;
    }
    ['handoffCard', 'designSelfReviewCard', 'immediateNextAction', 'documentationTaskCard', 'receipt', 'finalizeReceipt']
      .forEach(field => {
        if (Object.prototype.hasOwnProperty.call(projected, field)) {
          omittedFields.push(field);
          delete projected[field];
        }
      });
    projected.responseMode = isSilent ? 'silent_continuation' : 'bounded_continuation';
    projected.omittedFields = Array.from(new Set([...(projected.omittedFields || []), ...omittedFields]));
    let serialized = JSON.stringify(projected, null, 2);
    let responseBytes = Buffer.byteLength(serialized, 'utf8');
    if (responseBytes > MAX_CONTINUATION_RESPONSE_BYTES) {
      const keep = [
        'ok', 'status', 'designFinalized', 'stage', 'actionMode', 'source',
        'currentPhase', 'currentStepId', 'currentCardRef', 'postDesignNextAction',
        'documentationTaskCardRef', 'deliveryFactsRef', 'documentationNextAction',
        'documentationWarning', 'nextActionCard', 'allowedNextActions',
        'forbiddenActions', 'errorCode', 'message'
      ];
      const minimal = {};
      keep.forEach(field => {
        if (Object.prototype.hasOwnProperty.call(projected, field)) minimal[field] = projected[field];
      });
      minimal.responseMode = projected.responseMode;
      minimal.omittedFields = Array.from(new Set([
        ...(projected.omittedFields || []),
        ...Object.keys(payload).filter(field => !keep.includes(field))
      ]));
      serialized = JSON.stringify(minimal, null, 2);
      responseBytes = Buffer.byteLength(serialized, 'utf8');
      return { ...minimal, responseBytes };
    }
    return { ...projected, responseBytes };
  }

  _designPrepareContextToolResponse(payload = {}) {
    const status = String(payload && payload.status || '').trim().toLowerCase();
    const isBlocked = payload && payload.ok !== true
      && status !== 'repair_required'
      && (status === 'blocked' || /blocked$/.test(status) || String(payload.actionMode || '').trim());
    const responsePayload = this._projectDocumentationContinuation(payload);
    return {
      content: [{ type: "text", text: JSON.stringify(responsePayload, null, 2) }],
      isError: isBlocked
    };
  }

  _cleanupRequirementFinalizeIntermediates(requirementPaths = {}) {
    const demandArtifactDir = String(requirementPaths && requirementPaths.demandArtifactDir || '').trim();
    if (!demandArtifactDir) return { ok: false, reason: 'demand_artifact_dir_missing' };
    const normalizedDemandArtifactDir = path.resolve(demandArtifactDir);
    const candidatePaths = [
      path.join(normalizedDemandArtifactDir, 'rule-pool-draft-receipt.json'),
      path.join(normalizedDemandArtifactDir, 'rule-pool-rule-stage-receipt.json'),
      path.join(normalizedDemandArtifactDir, '.pipeline', 'requirement-generator-input.json')
    ];
    try {
      const snapshots = [requirementPaths.analysisStatePath, requirementPaths.finalizeReceiptPath]
        .map(file => { assertTemporaryPathSafe(normalizedDemandArtifactDir, file); return [file, fs.readFileSync(file)]; });
      const summary = removeTemporaryFiles(normalizedDemandArtifactDir, candidatePaths, {
        guard: () => snapshots.every(([file, raw]) => fs.existsSync(file) && fs.readFileSync(file).equals(raw))
      });
      if (!summary.skipped) removeEmptyTemporaryDirectory(normalizedDemandArtifactDir,
        path.join(normalizedDemandArtifactDir, '.pipeline'), summary);
      return summary;
    } catch (error) {
      return { ok: false, removed: [], removedFiles: 0, removedBytes: 0,
        errors: [{ message: String(error.message || error) }] };
    }
  }

  _readTextFileSafe(filePath) {
    try {
      if (!filePath || !fs.existsSync(filePath)) return '';
      return fs.readFileSync(filePath, 'utf-8');
    } catch (_) {
      return '';
    }
  }

  _readPomParentRelativePath(pomPath) {
    const content = this._readTextFileSafe(pomPath);
    if (!content) return '';
    const parentMatch = content.match(/<parent\b[\s\S]*?<\/parent>/i);
    if (!parentMatch) return '';
    const relMatch = parentMatch[0].match(/<relativePath\b[^>]*>([\s\S]*?)<\/relativePath>/i);
    return relMatch ? String(relMatch[1] || '').trim() : '../pom.xml';
  }

  _commonAncestorPath(leftPath, rightPath) {
    const left = path.resolve(leftPath || '');
    const right = path.resolve(rightPath || '');
    const leftParts = left.split(/[\\/]+/);
    const rightParts = right.split(/[\\/]+/);
    const max = Math.min(leftParts.length, rightParts.length);
    const common = [];
    const caseInsensitive = process.platform === 'win32';
    for (let i = 0; i < max; i++) {
      const l = caseInsensitive ? leftParts[i].toLowerCase() : leftParts[i];
      const r = caseInsensitive ? rightParts[i].toLowerCase() : rightParts[i];
      if (l !== r) break;
      common.push(leftParts[i]);
    }
    if (common.length === 0) return '';
    return common.join(path.sep) || path.parse(left).root;
  }

  _resolveMavenWorkspaceRoot(rawPath) {
    const requested = String(rawPath || '').trim();
    if (!requested) return { normalized: rawPath, changed: false };
    let modulePath;
    try {
      modulePath = path.resolve(requested);
    } catch (_) {
      return { normalized: rawPath, changed: false };
    }
    const pomPath = path.join(modulePath, 'pom.xml');
    if (!fs.existsSync(pomPath)) return { normalized: rawPath, changed: false };

    const parentRelativePath = this._readPomParentRelativePath(pomPath);
    if (!parentRelativePath) return { normalized: rawPath, changed: false };
    const parentPomPath = path.resolve(modulePath, parentRelativePath);
    if (!fs.existsSync(parentPomPath) || path.resolve(parentPomPath) === path.resolve(pomPath)) {
      return { normalized: rawPath, changed: false };
    }
    const parentDir = path.dirname(parentPomPath);
    const commonRoot = this._commonAncestorPath(modulePath, parentDir);
    if (!commonRoot || this._toComparableProjectPath(commonRoot) === this._toComparableProjectPath(modulePath)) {
      return { normalized: rawPath, changed: false };
    }
    const parsedRoot = path.parse(commonRoot).root;
    if (this._toComparableProjectPath(commonRoot) === this._toComparableProjectPath(parsedRoot)) {
      return { normalized: rawPath, changed: false };
    }
    return {
      normalized: commonRoot,
      changed: true,
      reason: 'maven_parent_workspace_root',
      evidence: {
        modulePomPath: pomPath,
        parentPomPath,
        parentRelativePath
      }
    };
  }

  /**
   * 解析任意 Skill 的 skillRoot。
   * 优先 process.env.EPOINT_SKILLS_ROOT，fallback 到 mcp_tools 同级仓库的 skills/<name>。
   * 不存在则返回空串。
   */
  _resolveSkillRoot(skillName) {
    const name = String(skillName || '').trim();
    if (!name) return '';
    const candidates = [];
    const envRoot = String(process.env.EPOINT_SKILLS_ROOT || '').trim();
    if (envRoot) {
      candidates.push(path.join(envRoot, name));
    }
    try {
      const mcpDir = path.resolve(__dirname);
      const repoRoot = path.resolve(mcpDir, '..', '..');
      candidates.push(path.join(repoRoot, 'skills', name));
    } catch (_) { /* ignore */ }
    for (const candidate of candidates) {
      if (candidate && fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return '';
  }

  /**
   * 在工具调用进入 beforeToolCall 之前，根据 args.skillName 自动激活 Skill。
   * 这样 SkillPolicyEnforcer 才能找到 policy.json。
   *
   * 幂等：当前 active skill 已经是同名时不重复激活；切换 Skill 时先 deactivate。
   * 安全：找不到 skillRoot 或 policy.json 时静默放弃，让下游 hardcoded 拦截兜底。
   */
  _autoActivateSkillIfNeeded(args = {}) {
    const parameters = args && args.parameters && typeof args.parameters === 'object' ? args.parameters : {};
    const skillName = this._extractSkillNameFromArgs(args);
    if (!skillName) return;
    const guard = this.skillRuntimeToolGuardService;
    if (!guard) return;
    const active = guard.activeSkill;
    if (active && active.skillName === skillName.toLowerCase()) {
      return; // 已激活
    }
    const skillRoot = this._resolveSkillRoot(skillName);
    if (!skillRoot) return;
    // 切换 Skill 时先 deactivate 旧的，避免互相串台
    if (active && active.token) {
      try { guard.deactivateSkill(active.token); } catch (_) { /* ignore */ }
    }
    try {
      guard.activateSkill(skillName, { skillRoot });
    } catch (_) {
      // activateSkill 内部失败不阻塞工具执行；hardcoded 拦截照旧
    }
  }

  _extractSkillNameFromArgs(args = {}) {
    const parameters = args && args.parameters && typeof args.parameters === 'object' ? args.parameters : {};
    return String(args && (args.skillName || args.skill || args.role ||
      parameters.skillName || parameters.skill || parameters.role) || '').trim();
  }

  _buildSkillNameRequiredResponse(toolName = '') {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: false,
          status: "blocked",
          actionMode: "pass_skill_name_then_retry",
          errorCode: "MCP_TOOL_SKILL_NAME_REQUIRED",
          message: `调用 ${toolName || '该 MCP 工具'} 必须传 skillName 字段，用于运行时审计和策略上下文。`,
          allowedNextActions: ["pass_skill_name_then_retry"],
          forbiddenActions: ["call_stateful_mcp_tool_without_skillName"]
        }, null, 2)
      }],
      isError: true
    };
  }

  _requireSkillNameForTool(toolName = '', args = {}) {
    if (!STATEFUL_MCP_TOOLS_REQUIRING_SKILL_NAME.has(toolName)) return null;
    return this._extractSkillNameFromArgs(args) ? null : this._buildSkillNameRequiredResponse(toolName);
  }

  _normalizeProjectPathByCwd(rawPath) {
    const requested = String(rawPath || '').trim();
    const root = String(this.workspaceRoot || '').trim();
    if (!requested || !root) {
      return { normalized: rawPath, changed: false };
    }
    let resolvedRoot;
    let resolvedRequested;
    try {
      resolvedRoot = path.resolve(root);
      resolvedRequested = path.resolve(requested);
    } catch (_) {
      return { normalized: rawPath, changed: false };
    }
    const caseInsensitive = process.platform === 'win32';
    const comparableRoot = caseInsensitive ? resolvedRoot.toLowerCase() : resolvedRoot;
    const comparableRequested = caseInsensitive ? resolvedRequested.toLowerCase() : resolvedRequested;
    if (comparableRequested === comparableRoot) {
      return { normalized: resolvedRoot, changed: resolvedRequested !== resolvedRoot };
    }
    const prefix = comparableRoot.endsWith(path.sep) ? comparableRoot : comparableRoot + path.sep;
    if (comparableRequested.startsWith(prefix)) {
      return { normalized: resolvedRoot, changed: true };
    }
    return { normalized: rawPath, changed: false };
  }

  _normalizeProjectPath(rawPath) {
    const cwdNorm = this._normalizeProjectPathByCwd(rawPath);
    const cwdPath = cwdNorm.changed ? cwdNorm.normalized : rawPath;
    const mavenNorm = this._resolveMavenWorkspaceRoot(cwdPath);
    if (mavenNorm.changed) {
      return {
        ...mavenNorm,
        originalNormalizedByCwd: cwdNorm.changed ? cwdNorm.normalized : ''
      };
    }
    return cwdNorm;
  }

  _extractRuntimeUserReply(request = {}) {
    const meta = request && request.params && request.params._meta && typeof request.params._meta === 'object'
      ? request.params._meta
      : {};
    const reply = meta.r2cUserReply && typeof meta.r2cUserReply === 'object'
      ? meta.r2cUserReply
      : (meta.userReply && typeof meta.userReply === 'object' ? meta.userReply : null);
    if (!reply) return null;
    const userReplyText = String(reply.userReplyText || reply.text || reply.message || '').trim();
    const userReplyHash = String(reply.userReplyHash || reply.hash || reply.messageHash || '').trim();
    const userReplyRef = String(reply.userReplyRef || reply.ref || reply.messageId || '').trim();
    if (!userReplyText && !userReplyHash && !userReplyRef) return null;
    return {
      userReplyText,
      userReplyHash,
      userReplyRef,
      source: String(reply.source || 'mcp_request_meta').trim() || 'mcp_request_meta'
    };
  }

  _attachRuntimeUserReply(args = {}, runtimeUserReply = null) {
    if (!runtimeUserReply || !RUNTIME_USER_REPLY_ARG_KEY) return args;
    Object.defineProperty(args, RUNTIME_USER_REPLY_ARG_KEY, {
      value: runtimeUserReply,
      enumerable: false,
      configurable: true,
      writable: false
    });
    return args;
  }

  _extractRuntimeReferenceRead(request = {}) {
    const meta = request && request.params && request.params._meta && typeof request.params._meta === 'object'
      ? request.params._meta
      : {};
    const source = meta.r2cReferenceContext || meta.r2cReferenceRead || meta.referenceRead || null;
    const sourceList = Array.isArray(meta.r2cReferenceReads)
      ? meta.r2cReferenceReads
      : (source ? [source] : []);
    const reads = sourceList
      .filter(item => item && typeof item === 'object')
      .map(item => ({
        referenceName: String(item.referenceName || item.name || '').trim(),
        referencePath: String(item.referencePath || item.path || '').trim(),
        phaseScope: String(item.phaseScope || item.scope || '').trim(),
        source: item.isFromReferenceFiles === true
          ? 'referenceFiles'
          : String(item.source || '').trim()
      }))
      .filter(item => item.referenceName && item.referencePath && item.source === 'referenceFiles');
    return reads.length > 0 ? reads : null;
  }

  _attachRuntimeReferenceRead(args = {}, runtimeReferenceRead = null) {
    if (!runtimeReferenceRead || !RUNTIME_REFERENCE_READ_ARG_KEY) return args;
    Object.defineProperty(args, RUNTIME_REFERENCE_READ_ARG_KEY, {
      value: runtimeReferenceRead,
      enumerable: false,
      configurable: true,
      writable: false
    });
    return args;
  }

  setupErrorHandling() {
    this.server.onerror = (error) => console.error("[MCP Error]", error);
    process.on("SIGINT", async () => {
      await this.server.close();
      process.exit(0);
    });
  }


  _buildDesignTddDocumentationContext({
    projectPath = '',
    codePaths = {},
    documentStage = 'coder',
    documentationSkillName = 'epoint-design-tdd-coder',
    materializedFiles = [],
    generatedArtifactsIndex = null,
    additionalInputRefs = []
  } = {}) {
    try {
      const businessFactsPath = path.join(codePaths.codeDir, 'business-facts.json');
      const designRead = this._readJsonIfExists(codePaths.designDocumentPath);
      const planRead = this._readJsonIfExists(path.join(codePaths.codeDir, 'design-tdd-plan.json'));
      const globalPaths = this.projectScanService.getProjectStructurePaths(projectPath);
      const documentationResult = this.designTddDeliveryDocumentationService.buildTaskCard({
        documentStage,
        projectPath,
        demandDir: codePaths.demandDir,
        codeDir: codePaths.codeDir,
        designDocumentPath: codePaths.designDocumentPath,
        designMarkdownPath: codePaths.designMarkdownPath,
        requirementStoriesPath: codePaths.requirementStoriesPath,
        requirementRulePoolPath: codePaths.requirementRulePoolPath,
        deliveryFactsPath: codePaths.deliveryFactsPath,
        documentationTaskCardPath: codePaths.documentationTaskCardPath,
        businessFactsPath,
        codeStatePath: codePaths.codeStatePath,
        finalizeReceiptPath: codePaths.finalizeReceiptPath,
        design: designRead.ok ? designRead.value : null,
        designTddPlan: planRead.ok ? planRead.value : null,
        materializedFiles: Array.isArray(materializedFiles) ? materializedFiles : [],
        generatedArtifactsIndex,
        additionalInputRefs,
        restInterfaceStyleContractPath: globalPaths.restInterfaceStyleContractPath
      });
      if (documentationResult.ok !== true) {
        return {
          card: null,
          warning: {
            code: 'DESIGN_TDD_DOCUMENTATION_CONTEXT_UNAVAILABLE',
            message: `${documentStage}阶段已成功完成，但人读交付文档上下文未生成。`,
            details: documentationResult
          }
        };
      }
      const card = documentationResult.card;
      const documentationGrant = this.skillRuntimeToolGuardService.installDocumentationGrant(projectPath, {
        skillName: documentationSkillName,
        readableRefs: card.inputRefs,
        readableExtraFiles: []
          .concat(card.documentationTaskCardRef ? [card.documentationTaskCardRef.path] : [])
          .concat(card.deliverySummaryTemplateRef ? [card.deliverySummaryTemplateRef.path] : [])
          .concat(card.templateRef ? [card.templateRef.path] : []),
        outputRoot: card.outputRoot,
        manualRoot: card.manualRoot
      });
      if (!documentationGrant || documentationGrant.ok !== true) {
        return {
          card: null,
          warning: {
            code: 'DESIGN_TDD_DOCUMENTATION_SCOPE_UNAVAILABLE',
            message: `${documentStage}阶段已成功完成，但人读交付文档写入边界未建立。`,
            details: documentationGrant || null
          }
        };
      }
      return { card, warning: null };
    } catch (error) {
      return {
        card: null,
        warning: {
          code: 'DESIGN_TDD_DOCUMENTATION_CONTEXT_FAILED',
          message: `${documentStage}阶段已成功完成，但人读交付文档上下文生成异常。`,
          cause: String(error && error.message || error)
        }
      };
    }
  }

  _createMcpProgressReporter(request = {}) {
    const progressToken = request
      && request.params
      && request.params._meta
      ? request.params._meta.progressToken
      : undefined;
    if (progressToken === undefined || progressToken === null) {
      return async () => {};
    }

    let lastProgress = -1;
    return async ({ progress = 0, total, message = '' } = {}) => {
      const normalizedProgress = Number(progress);
      const normalizedTotal = Number(total);
      if (!Number.isFinite(normalizedProgress) || normalizedProgress < lastProgress) return;
      lastProgress = normalizedProgress;
      const params = {
        progress: normalizedProgress,
        progressToken
      };
      if (Number.isFinite(normalizedTotal) && normalizedTotal >= 0) params.total = normalizedTotal;
      const normalizedMessage = String(message || '').trim();
      if (normalizedMessage) params.message = normalizedMessage.slice(0, 500);
      try {
        await this.server.notification({
          method: 'notifications/progress',
          params
        });
      } catch (error) {
        // 进度是客户端可选能力；传输不支持或已断开时不能影响骨架物化结果。
        console.error(`[MCP Progress] Failed to send progress notification: ${error.message}`);
      }
    };
  }

  async _handleDesignTddSkeletonMaterialize(args = {}, { reportProgress = null } = {}) {
    const notifyProgress = typeof reportProgress === 'function'
      ? async payload => {
        try {
          await reportProgress(payload);
        } catch (error) {
          // 自定义测试/宿主进度回调异常也不能改变骨架生成结果。
          console.error(`[MCP Progress] Progress callback failed: ${error.message}`);
        }
      }
      : async () => {};
    const batch = this.designTddCodeRuntimeService.getSkeletonWork(args);
    if (!batch.ok) return batch;
    if (batch.status === 'skeleton_completed_replay') {
      // 已完成状态是可重放的只读结果。不要再次要求 design 文档、Workflow
      // 回执或账本存在；这些中间资料在完成后可能已按清理策略移除。
      await notifyProgress({
        progress: 1,
        total: 1,
        message: '骨架已完成，返回可重放结果。'
      });
      return this.designTddCodeRuntimeService.replaySkeletonCompletion({ batch });
    }
    const pendingTotal = Array.isArray(batch.pendingFiles) ? batch.pendingFiles.length : 0;
    let processedCount = 0;
    const notifyFileProgress = async (pending, outcome) => {
      processedCount += 1;
      await notifyProgress({
        progress: processedCount,
        total: pendingTotal,
        message: `骨架生成 ${processedCount}/${pendingTotal}：${path.basename(String(pending && pending.path || '当前文件'))}${outcome || '已完成'}`
      });
    };
    await notifyProgress({
      progress: 0,
      total: pendingTotal,
      message: `骨架生成准备中，共 ${pendingTotal} 个待处理文件。`
    });
    const skeletonService = this.designTddSkeletonService;
    const archiveService = new SkeletonManifestArchiveService();
    const materializedFiles = [];
    const factsRead = this._readJsonIfExists(batch.resolved.factsPath);
    if (!factsRead.ok) {
      return {
        ok: false,
        status: 'blocked',
        errorCode: 'DESIGN_TDD_BUSINESS_FACTS_INVALID',
        message: `骨架物化前business-facts.json无法读取：${batch.resolved.factsPath}`,
        materializedCount: 0
      };
    }
    const designJsonPath = path.join(batch.resolved.demandDir, 'design', '设计文档.json');
    const designRead = this._readJsonIfExists(designJsonPath);
    if (!designRead.ok) {
      return {
        ok: false,
        status: 'blocked',
        errorCode: 'DESIGN_TDD_DESIGN_DOCUMENT_INVALID',
        message: `骨架物化前最终设计合同无法读取：${designJsonPath}`,
        materializedCount: 0,
        allowedNextActions: ['rerun_design_prepare_context_before_tdd']
      };
    }
    const workflowReceipt = this.designWorkflowArtifactService.validateReceipt({
      designDir: path.join(batch.resolved.demandDir, 'design'),
      design: designRead.value
    });
    if (!workflowReceipt.ok) {
      return {
        ...workflowReceipt,
        materializedCount: 0,
        allowedNextActions: workflowReceipt.allowedNextActions || ['rerun_design_prepare_context_before_tdd']
      };
    }
    let workflowArtifactsIndex = { ok: true, artifacts: [] };
    if ((workflowReceipt.artifacts || []).length > 0) {
      workflowArtifactsIndex = this.designTddGeneratedArtifactsService.writeMerged({
        codeDir: batch.resolved.codeDir,
        artifacts: workflowReceipt.artifacts.map(item => ({
          ...item,
          fileName: path.basename(item.path),
          consumerSkill: 'epoint-workflow-coder',
          source: 'requirement_design_finalize',
          summary: '设计阶段已生成，Coder 只读消费'
        }))
      });
      if (!workflowArtifactsIndex.ok) {
        return {
          ...workflowArtifactsIndex,
          ok: false,
          status: 'blocked',
          materializedCount: 0
        };
      }
    }
    const failedFiles = [];
    const recordFailure = (pending, result, fallbackCode, fallbackMessage, extra = {}) => {
      const failure = result && typeof result === 'object' ? result : {};
      failedFiles.push({
        moduleId: String(pending && pending.moduleId || '').trim(),
        fileKind: String(pending && pending.fileKind || '').trim(),
        targetFile: String(pending && pending.path || '').trim(),
        status: String(failure.status || 'failed').trim() || 'failed',
        errorCode: String(failure.errorCode || fallbackCode || 'DESIGN_TDD_SKELETON_BATCH_ITEM_FAILED').trim(),
        message: String(failure.message || fallbackMessage || `骨架物化失败：${pending && pending.path || ''}`).trim(),
        ...(failure.cause ? { cause: String(failure.cause).trim() } : {}),
        ...extra
      });
    };

    // 每个 owner 文件独立处理。单文件的路径/身份/规则问题仍然拒绝写入该文件，
    // 但不能用一个失败项终止其它安全文件。
    for (const pending of batch.pendingFiles) {
      const ownerFile = pending.ownerFile && typeof pending.ownerFile === 'object' ? pending.ownerFile : {};
      let result;
      try {
        result = skeletonService.materialize({
          ...ownerFile,
          projectPath: batch.resolved.projectPath,
          moduleId: pending.moduleId,
          targetFile: pending.path,
          fileKind: pending.fileKind,
          action: 'create'
        });
      } catch (error) {
        result = {
          ok: false,
          status: 'failed',
          errorCode: 'DESIGN_TDD_SKELETON_BATCH_ITEM_EXCEPTION',
          message: `骨架物化异常：${pending.path}`,
          cause: String(error && error.message || error)
        };
      }
      if (!result || result.ok !== true) {
        recordFailure(
          pending,
          result,
          'DESIGN_TDD_SKELETON_BATCH_ITEM_FAILED',
          `骨架物化失败：${pending.path}`,
          { allowedNextActions: ['fix_current_skeleton_projection_then_retry'] }
        );
        await notifyFileProgress(pending, '失败');
        continue;
      }
      const slim = Array.isArray(result.materializedFiles) && result.materializedFiles[0]
        ? result.materializedFiles[0]
        : {};
      const audit = result._audit && result._audit.materializedFile && typeof result._audit.materializedFile === 'object'
        ? result._audit.materializedFile
        : {};
      const materialized = { ...audit, ...slim };
      let registered;
      try {
        registered = archiveService.register({
          demandDir: batch.resolved.demandDir,
          moduleId: pending.moduleId,
          fileKind: pending.fileKind,
          targetFile: String(materialized.targetFile || pending.path),
          materializedFile: materialized
        });
      } catch (error) {
        registered = {
          ok: false,
          reason: 'ledger_write_failed',
          message: String(error && error.message || error)
        };
      }
      if (!registered.ok) {
        recordFailure(
          pending,
          {
            ok: false,
            status: 'failed',
            errorCode: 'DESIGN_TDD_SKELETON_LEDGER_WRITE_FAILED',
            message: `骨架已生成但进度登记失败：${pending.path}`,
            cause: registered.message || registered.reason || ''
          },
          'DESIGN_TDD_SKELETON_LEDGER_WRITE_FAILED',
          `骨架已生成但进度登记失败：${pending.path}`,
          { allowedNextActions: ['fix_code_directory_write_then_retry'] }
        );
        await notifyFileProgress(pending, '登记失败');
        continue;
      }
      materializedFiles.push({
        moduleId: pending.moduleId,
        fileKind: pending.fileKind,
        targetFile: String(materialized.targetFile || pending.path),
        status: String(materialized.status || 'materialized')
      });
      await notifyFileProgress(pending, '已完成');
    }

    if (failedFiles.length > 0) {
      return this._buildDesignTddSkeletonPartialResponse({
        batch,
        materializedFiles,
        failedFiles,
        partialReason: 'item_failed'
      });
    }
    const workflowArtifacts = workflowReceipt.receipt && Array.isArray(workflowReceipt.receipt.workflows)
      ? workflowReceipt.receipt.workflows
      : [];
    const compileFiles = Array.from(new Set([...(batch.materializedFiles || []), ...materializedFiles]
      .map(item => String(item && (item.targetFile || item.resolvedPath || item.filePath || item.path) || '').trim())
      .filter(Boolean)));
    const skeletonCompileCheck = {
      ok: true,
      ran: false,
      result: 'skipped',
      reason: 'deferred_to_direct_vibecoding',
      message: '骨架阶段不执行 Maven 编译；由后续纯提示词 Vibe Coding 按连续实现批次自行验证。'
    };
    const compileReceipt = this.designTddCodeRuntimeService.recordSkeletonCompileReceipt({
      projectPath: args.projectPath,
      result: skeletonCompileCheck,
      files: compileFiles
    });
    if (!compileReceipt || compileReceipt.ok !== true) {
      return this._buildDesignTddSkeletonPartialResponse({
        batch,
        materializedFiles,
        failedFiles: [{
          moduleId: '',
          fileKind: 'skeleton-compile-receipt',
          targetFile: batch.resolved.skeletonCompileReceiptPath,
          status: 'failed',
          errorCode: compileReceipt && compileReceipt.errorCode || 'DESIGN_TDD_SKELETON_COMPILE_RECEIPT_WRITE_FAILED',
          message: compileReceipt && compileReceipt.message || '骨架执行凭证写盘失败，已生成文件保留，下一次调用将重试登记。',
          allowedNextActions: ['retry_design_tdd_skeleton_materialize']
        }],
        skeletonCompileCheck
      });
    }
    const next = this.designTddCodeRuntimeService.completeSkeletonBatch({ projectPath: args.projectPath });
    if (!next || next.ok !== true) {
      return this._buildDesignTddSkeletonPartialResponse({
        batch,
        materializedFiles,
        failedFiles: [{
          moduleId: '',
          fileKind: 'skeleton-progress',
          targetFile: batch.resolved.statePath,
          status: 'failed',
          errorCode: next && next.errorCode || 'DESIGN_TDD_SKELETON_PROGRESS_INCOMPLETE',
          message: next && next.message || '骨架进度尚未闭合，已生成文件保留，下一次调用将按账本继续。',
          allowedNextActions: ['retry_design_tdd_skeleton_materialize']
        }]
      });
    }
    // 精简响应：只返回引用式合同，不回传 materializedFiles/workflowArtifacts/state/compileReceipt 等大字段。
    // 这些证据继续落盘，由测试直接读取状态、账本、Workflow 索引和凭证验证。
    return {
      ok: true,
      status: next.status,
      phase: next.phase,
      codingMode: next.codingMode,
      awaitingUser: next.awaitingUser,
      stopAfter: next.stopAfter,
      responseMode: next.responseMode,
      completionSummary: next.completionSummary,
      displayLine: next.displayLine,
      skillName: next.skillName,
      projectPath: next.projectPath,
      coderIntakeRef: next.coderIntakeRef,
      implementationTasksPath: next.implementationTasksPath,
      nextActionCard: next.nextActionCard,
      allowedNextActions: next.allowedNextActions,
      forbiddenActions: next.forbiddenActions
    };
  }

  _buildDesignTddSkeletonPartialResponse({
    batch = {},
    materializedFiles = [],
    failedFiles = [],
    skeletonCompileCheck = null,
    partialReason = ''
  } = {}) {
    const resolved = batch && batch.resolved || {};
    let refreshed = null;
    try {
      refreshed = this.designTddCodeRuntimeService.refreshSkeletonProgress({
        resolved,
        state: batch.state,
        plan: batch.plan,
        transitionToVibe: false
      });
    } catch (error) {
      refreshed = {
        ok: false,
        errorCode: 'DESIGN_TDD_SKELETON_PROGRESS_REFRESH_FAILED',
        message: `骨架进度刷新异常：${String(error && error.message || error)}`
      };
    }

    const plannedFallback = Number(batch.plannedCount || 0)
      || ((Array.isArray(batch.pendingFiles) ? batch.pendingFiles.length : 0)
        + (Array.isArray(batch.materializedFiles) ? batch.materializedFiles.length : 0));
    const refreshedSkeleton = refreshed && refreshed.ok === true && refreshed.state && refreshed.state.skeleton
      ? refreshed.state.skeleton
      : {};
    const refreshedCountsAvailable = refreshed && refreshed.ok === true
      && refreshed.state && refreshed.state.skeleton
      && Number.isInteger(Number(refreshed.state.skeleton.plannedCount))
      && Number.isInteger(Number(refreshed.state.skeleton.materializedCount))
      && Number.isInteger(Number(refreshed.state.skeleton.pendingCount));
    const completionSummary = {
      plannedCount: refreshedCountsAvailable ? Number(refreshedSkeleton.plannedCount) : plannedFallback,
      materializedCount: refreshedCountsAvailable
        ? Number(refreshedSkeleton.materializedCount)
        : ((Array.isArray(batch.materializedFiles) ? batch.materializedFiles.length : 0) + materializedFiles.length),
      pendingCount: refreshedCountsAvailable
        ? Number(refreshedSkeleton.pendingCount)
        : Math.max(0, plannedFallback - ((Array.isArray(batch.materializedFiles) ? batch.materializedFiles.length : 0) + materializedFiles.length))
    };
    const normalizedFailures = (Array.isArray(failedFiles) ? failedFiles : [])
      .map(item => ({
        moduleId: String(item && item.moduleId || '').trim(),
        fileKind: String(item && item.fileKind || '').trim(),
        targetFile: String(item && item.targetFile || '').trim(),
        status: String(item && item.status || 'failed').trim() || 'failed',
        errorCode: String(item && item.errorCode || 'DESIGN_TDD_SKELETON_BATCH_ITEM_FAILED').trim(),
        message: String(item && item.message || '骨架物化失败。').trim().slice(0, 2000),
        ...(item && item.cause ? { cause: String(item.cause).trim().slice(0, 2000) } : {}),
        ...(Array.isArray(item && item.allowedNextActions)
          ? { allowedNextActions: item.allowedNextActions.map(value => String(value || '').trim()).filter(Boolean) }
          : {})
      }))
      .filter(item => item.targetFile || item.errorCode)
      .slice(0, 50);
    const firstFailure = normalizedFailures[0] || {};
    const projectPath = String(resolved.projectPath || '').trim();
    const retryArgs = {
      projectPath,
      skillName: 'epoint-design-tdd-coder',
      ...(firstFailure.moduleId ? { moduleId: firstFailure.moduleId } : {}),
      ...(firstFailure.fileKind && firstFailure.fileKind !== 'skeleton-compile-receipt'
        ? { fileKind: firstFailure.fileKind }
        : {}),
      ...(firstFailure.targetFile && firstFailure.fileKind !== 'skeleton-compile-receipt'
        ? { targetFile: firstFailure.targetFile }
        : {})
    };
    const displayTarget = firstFailure.targetFile ? path.basename(firstFailure.targetFile) : '进度凭证';
    const displayLine = firstFailure.targetFile
      ? `骨架物化部分完成：计划 ${completionSummary.plannedCount} 个文件，成功 ${completionSummary.materializedCount} 个，剩余 ${completionSummary.pendingCount} 个；首个失败 ${displayTarget}（${firstFailure.errorCode || 'unknown'}）。`
      : `骨架物化部分完成：计划 ${completionSummary.plannedCount} 个文件，成功 ${completionSummary.materializedCount} 个，剩余 ${completionSummary.pendingCount} 个；请按返回的失败信息重试。`;
    const progressRefreshFailure = refreshed && refreshed.ok !== true
      ? {
        errorCode: refreshed.errorCode || 'DESIGN_TDD_SKELETON_PROGRESS_REFRESH_FAILED',
        message: refreshed.message || '骨架进度刷新失败，下一次调用将重试。'
      }
      : null;
    return {
      ok: true,
      status: 'skeleton_partial',
      phase: 'skeleton_materialize',
      codingMode: '',
      awaitingUser: false,
      stopAfter: false,
      responseMode: 'continue_skeleton_materialize',
      completionSummary,
      ...(partialReason ? { partialReason } : {}),
      failedFiles: normalizedFailures,
      ...(progressRefreshFailure ? { progressRefreshFailure } : {}),
      ...(skeletonCompileCheck ? { skeletonCompileCheck } : {}),
      nextActionCard: {
        title: `骨架物化部分完成，继续处理 ${completionSummary.pendingCount} 个未完成项`,
        stopAfter: false,
        displayRequired: true,
        displayLine,
        instruction: firstFailure.targetFile
          ? '先向用户说明 failedFiles 中的 errorCode 和 message；修复对应当前投影后，按 toolCall.arguments 原样再次调用 design_tdd_skeleton_materialize。已成功文件由账本跳过，不要删除或重物化。'
          : '请按 toolCall.arguments 原样再次调用 design_tdd_skeleton_materialize，已成功文件由账本跳过，不要删除或重物化。',
        toolCall: {
          mcpServer: 'epoint-project-rules',
          via: 'run_mcp',
          toolName: 'design_tdd_skeleton_materialize',
          arguments: retryArgs,
          instruction: '按 arguments 原样调用 design_tdd_skeleton_materialize 一次；不要搜索、不要删除已生成文件。'
        },
        callTemplate: `design_tdd_skeleton_materialize(${JSON.stringify(retryArgs)})`
      },
      projectPath,
      allowedNextActions: ['explain_failed_files_then_retry_design_tdd_skeleton_materialize'],
      forbiddenActions: [
        'start_vibe_coding_before_skeleton_completed',
        'delete_successful_skeleton_files_and_regenerate',
        'guess_missing_file_name_or_section_key'
      ]
    };
  }

  getToolDefinitions() {
    const tools = [
        {
          name: "rule_expert",
          description: "【规则检索】用于搜索规范库、读取规范正文（read/search）。action=read 始终直接返回规范全文，不返回摘要。设计阶段不要用 action=analyze/execute；模块化提交请用对应阶段的专用工具：需求阶段 req_finalize_artifacts、设计阶段 design_prepare_context、TDD 阶段 design_tdd_skeleton_materialize。",
          inputSchema: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: ["search", "read", "analyze", "execute"],
                description: "执行动作：search(搜索关键词), read(读取并直接返回规范全文), analyze(识别需求意图/匹配规范), execute(执行规范定义的代码生成动作)"
              },
              skillName: { type: "string", description: "调用方 Skill 名称；用于运行时审计和策略上下文" },
              keyword: { type: "string", description: "搜索关键词 (用于 search)" },
              ruleName: { type: "string", description: "规范名称/ID (用于 read/execute)" },
              userIntent: { type: "string", description: "用户需求文本 (用于 analyze)" },
              actionName: { type: "string", description: "具体动作名 (用于 execute)" },
              params: { type: "object", description: "动作所需的参数 (用于 execute)" },
              projectPath: { type: "string", description: "项目物理路径；用于解析项目级规则和读取 analysis-state.json 已确认决策" },
              storyId: { type: "string", description: "当前 User Story ID（如 US1）；analyze 时 Builder 自动累积到 analysis-state.json.storyIds" },
              versionBucket: { type: "string", enum: ["950及以上", "950以下"], description: "版本桶；read 读取同名代码生成规范时用于区分 950 桶" },
              outputDir: { type: "string", description: "read 默认瘦身输出时的规则全文落盘目录" },
              outputMode: {
                type: "string",
                enum: ["slim", "full"],
                description: "兼容字段：action=read 时无论是否传 slim/full 都直接返回规范全文；其它动作按各自合同处理"
              }
            },
            required: ["action", "skillName"]
          }
        },
        {
          name: "list_rules",
          description: "列出项目所有可用的规范文档",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "team_rules_search",
          description: "【团队规则检索】基于团队预构建的 knowledge.sqlite 做 SQLite FTS 全文检索。索引由管理员用 knowledge-inbox build-sqlite/publish 推到团队知识库 GitLab 仓库；插件按 vscode 设置中的“规范保存路径”自动 sparse-checkout 到 {rulesPath}/.knowledge_repo（仅含 knowledge.sqlite）。本工具直接本地查询，毫秒返回。结果带命中关键词、证据片段和召回解释。",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "自然语言查询，例如 \"代码审核规范\"" },
              top_k: { type: "integer", description: "返回 top K 条结果（默认 5）" },
              category: { type: "string", description: "可选分类过滤，如 'rules' / 'projects' / 'knowledge'" }
            },
            required: ["query"]
          }
        },
        {
          name: "team_rule_get",
          description: "【团队规则全文】按 file_path（来自 team_rules_search 结果）从团队知识库 GitLab 仓库在线读取规则的完整 markdown 原文（含 frontmatter 与 pre-H2 引言段），用于喂给 LLM。优先级：远端 HTTP > 本地 .md > index.json 兼容重建。不写盘，毫秒到秒级返回。",
          inputSchema: {
            type: "object",
            properties: {
              file_path: { type: "string", description: "相对于规则仓库根的路径，如 'rules/code-review.md'" }
            },
            required: ["file_path"]
          }
        },
        {
          name: "project_scan",
          description: "【独立项目勘测】项目级 scan 入口。生成/刷新 .ai-workspace/project 下的项目现状报告、工程导航契约、compact 契约、框架档位和资产索引；不创建流水线计划，不推进 requirement/design/code。",
          inputSchema: {
            type: "object",
            properties: {
              projectPath: { type: "string", description: "项目物理路径" },
              userIntent: { type: "string", description: "可选补充，如：刷新基线、950及以上、950以下、关注某模块" }
            },
            required: ["projectPath"]
          }
        },
        {
          name: "gate_contract",
          description: "【统一门禁合同入口】按 businessKey/stageKey/artifactKind/gateId/profile 获取对应门禁合同；Skill 与 Gate 必须同源消费该合同。",
          inputSchema: {
            type: "object",
            properties: {
              businessKey: { type: "string", description: "已注册门禁合同的业务场景标识" },
              stageKey: { type: "string", description: "已注册合同的阶段标识；需求、设计和骨架提交使用各自专用 Builder 入口" },
              artifactKind: { type: "string", description: "已注册门禁合同的产物类型" },
              gateId: { type: "string", description: "消费门禁的稳定标识" },
              profile: { type: "string", description: "可选 profile，如 expert / website；缺省走通用合同" },
              outputMode: {
                type: "string",
                enum: ["slim", "full"],
                description: "输出模式：slim=默认，只返回 Planner 必需合同摘要；full=返回完整合同"
              }
            },
            required: ["businessKey", "stageKey", "artifactKind", "gateId"]
          }
        },
        {
          name: "batch_audit_task",
          description: "【通用批量审计/验证】工厂模式：根据关联规范自动执行扫描与验证生命周期。⚠️ 重要：当工具返回 '[WAITING_FOR_USER_INPUT]' 时，你必须**立即停止所有后续操作**，将响应内容完整呈现给用户并等待确认。",
          inputSchema: {
            type: "object",
            properties: {
              userIntent: { type: "string", description: "用户意图" },
              projectPath: { type: "string", description: "当前绝对真实的工程根目录物理路径（注意：必须精确到项目最深层打开的完整路径，严禁将路径向上方级截断或主观拼凑！）" },
              phase: {
                type: "string",
                enum: ["audit", "verify"],
                description: "执行阶段：audit(审计产出清单), verify(验证整改结果)"
              },
              specificRequirements: { type: "string", description: "关联规范ID" }
            },
            required: ["projectPath"],
          },
        },
        {
          name: "security_audit_task",
          description: "【专项任务：脱敏整改】仅用于识别代码中的脱敏安全隐患（如姓名、手机号曝光）。它会生成审查清单并按需进行专项替换。⚠️ 重要：当工具返回 '[WAITING_FOR_USER_INPUT]' 时，你必须**立即停止**，将响应内容呈现给用户并等待确认。",
          inputSchema: {
            type: "object",
            properties: {
              userIntent: { type: "string", description: "脱敏整改相关意图" },
              projectPath: { type: "string", description: "当前绝对真实的工程根目录物理路径（注意：必须精确到项目最深层打开的完整路径，严禁将路径向上方级截断或主观拼凑！）" },
              specificRequirements: { type: "string", description: "特定需求或关联规范ID" }
            },
            required: ["projectPath"],
          },
        },
        {
          name: "compatibility_audit_task",
          description: "【国产化适配专家】三阶段闭环工作流：audit(扫描生成清单) → fix(逐文件适配+自动更新清单) → verify(验证)。audit 完成后自动输出待处理文件列表引导用户选择；fix 阶段自动加载该文件的风险点和转换规则，生成适配指令并强制要求更新清单状态；完成后自动输出剩余文件继续引导。⚠️ 当返回 '[WAITING_FOR_USER_INPUT]' 或 '🛑 [STOP]' 时，必须立即停止将内容呈现给用户并等待指令。",
          inputSchema: {
            type: "object",
            properties: {
              userIntent: { type: "string", description: "国产化适配意图（如 '从 Oracle 转到 PostgreSQL'）" },
              projectPath: { type: "string", description: "当前绝对真实的工程根目录物理路径（注意：必须精确到项目最深层打开的完整路径，如 'D:\\...\\7.11（升级专用）政务服务'，严禁将路径向上级截断或主观猜测！）" },
              phase: {
                type: "string",
                enum: ["audit", "fix", "verify"],
                description: "执行阶段：audit(扫描产出清单), fix(逐文件适配), verify(验证整改结果)"
              },
              targetFile: { type: "string", description: "目标文件名（fix 阶段必填，如 'XxxService.java'）" }
            },
            required: ["projectPath", "phase"],
          },
        },
        {
          name: "create_rule",
          description: "【规范沉淀工具】自动生成标准化的 .mdc 规范文件并保存到用户规则目录。",
          inputSchema: {
            type: "object",
            properties: {
              ruleName: { type: "string", description: "规范名称（不含扩展名）" },
              description: { type: "string", description: "规范简要描述" },
              category: { type: "string", description: "规则分类" },
              intentKeywords: { type: "array", items: { type: "string" }, description: "意图关键词列表" },
              ruleContent: { type: "string", description: "规范正文内容" },
              overwrite: { type: "boolean", description: "是否覆盖已存在的同名文件" }
            },
            required: ["ruleName", "description", "ruleContent"],
          },
        },
        {
          name: "enhance_prompt",
          description: "【核心辅助：提示词降维强化】强制指令重构入口。当用户明确提及“提示词强化”、“优化提示词”、“重构需求”或输入内容过于口语化/模糊时，必须调用此工具。工具会锁定“深层思考”、“Mom Test”及“PARE 拆解”三大方法论输出究极工程提示词。请务必在生成具体代码/方案前先调用此工具进行重构。",
          inputSchema: {
            type: "object",
            properties: {
              originalPrompt: { type: "string", description: "需要进行强化的原始模糊提示词内容" }
            },
            required: ["originalPrompt"]
          }
        },
        {
          name: "design_prepare_context",
          description: "【需求设计唯一入口与恢复入口】无phase时建立或恢复当前卡；structure_confirmed用decisionRows提交TABLE/RELATION/STORY；details_confirmed用detailRows补字段与REST；字段闭合后page_design_confirmed用compositionRows提交LLM页面设计并自动finalize。每次写提交必须携带prepare返回的stepId。",
          inputSchema: {
            type: "object",
            properties: {
              projectPath: { type: "string", description: "业务项目根目录；必须包含 .ai-workspace/project/.active-demand 与需求阶段机器产物" },
              skillName: { type: "string", description: "当前 Skill 名称，必须为 epoint-requirement-design" },
              stepId: { type: "string", description: "写提交必填；从上一次prepare/currentCardRef取得。相同stepId+相同payload幂等，不同payload返回stale。" },
              phase: {
                type: "string",
                enum: ["prepare", "structure_confirmed", "details_confirmed", "page_design_confirmed"],
                description: "缺省/prepare=建立或恢复当前卡；structure_confirmed=提交表/关系/Story骨架；details_confirmed=提交当前字段/API批次；page_design_confirmed=字段闭合后提交页面布局、业务块和字段分区"
              },
              decisionRows: decisionRowsSchema(),
              detailRows: detailRowsSchema(),
              compositionRows: compositionRowsSchema(),
              ...FeedbackContract.properties(true)
            },
            required: ["projectPath"],
            allOf: FeedbackContract.conditions(true)
          }
        },
        {
          name: "req_prepare_context",
          description: "【需求分析入口上下文包】面向 epoint-requirement-analyzer 的第一步入口。一次性锁定 .active-demand、demandDir 与需求分析阶段固定产物路径，禁止 LLM 自行拼接 demand 目录或写入非 canonical demand 路径。**首次跑（无 .active-demand）时**：从用户首句业务描述派生 2-8 字中文 demandName 后调本工具（不含日期前缀，Builder 自动加 yyyy-MM-dd_）；**禁止**询问用户、file_search/view_folder 探测目录、fs_write 创建 .active-demand。",
          inputSchema: {
            type: "object",
            properties: {
              projectPath: { type: "string", description: "业务项目根目录；必须包含 .ai-workspace/project/.active-demand" },
              skillName: { type: "string", description: "当前 Skill 名称，必须为 epoint-requirement-analyzer" },
              demandName: { type: "string", description: "首次创建需求分析锚点时的需求名称（2-8 字中文业务名，从用户最初需求描述派生，如 '大厅地址管理'）。已有 .active-demand 时无需传入；**不要含日期前缀**（Builder 自动加 yyyy-MM-dd_）；不要含 / \\ 等路径分隔符，不要绝对路径。**禁止**：询问用户、扫目录、自创 .active-demand 文件——这些路径由 Builder 工具自动创建。" },
              ...FeedbackContract.properties()
            },
            required: ["projectPath", "skillName"],
            allOf: FeedbackContract.conditions()
          }
        },
        {
          name: "req_finalize_artifacts",
          description: "【需求分析最终产物验证】epoint-requirement-analyzer 完成前唯一最终验证入口。按 .active-demand 固定路径验证 analysis-state.json、stories.json、rule-pool.json 等机器产物闭合，Builder 自动标记 state done 并生成 demand/需求分析.md，最后写 requirement-finalize-receipt.json。未 ok=true 前禁止回复“需求分析已完成”。",
          inputSchema: {
            type: "object",
            properties: {
              projectPath: { type: "string", description: "项目物理路径；用于从 .active-demand 推导 demand 固定路径" },
              skillName: { type: "string", description: "当前 Skill 名称，必须为 epoint-requirement-analyzer" }
            },
            required: ["projectPath", "skillName"]
          }
        },
        {
          name: "req_rule_pool_build_rule_draft",
          description: "【需求规则池 Builder 规则草案】Step 6.6 第一阶段。Builder 自动读取 .active-demand、analysis-state 和 stories.json，按 Story 召回业务规则与项目表候选，写 draft receipt；需求分析.md 仅作旧需求兼容兜底。本工具只返回规则候选 confirmationCard + ruleDraftId，LLM 只展示规则卡并等待用户规则决策。若用户明确要求必须使用某张已有项目表，必须把真实 tableName/entityName 放入 userSupplementTableNames 字符串数组；普通补充说明仍放 userSupplement。Builder 会按 scan 实体图核对，未扫描到就阻断，不会猜表或静默漏表。",
          inputSchema: {
            type: "object",
            properties: {
              projectPath: { type: "string", description: "项目物理路径；用于从 .active-demand 推导需求目录并读取需求阶段产物" },
              userSupplement: { type: "string", description: "可选；用户要求补充或重查候选时，LLM 将补充原文传入以重新生成规则草案" },
              userSupplementTableNames: { type: "array", description: "可选但有明确语义：只有用户明确说‘必须使用/固定使用’的已有项目表才填写真实 tableName 或 entityName，例如 [\"xm_dingtalk_report_cache\"]；普通补充说明不要放这里。Builder 会逐项核对本次 project_scan 的 entity-graph 候选，缺失时阻断并提示先刷新扫描；成功后这些表不能在表决策中被剔除。", items: { type: "string" } },
              skillName: { type: "string", description: "当前 Skill 名称，必须为 epoint-requirement-analyzer" }
            },
            required: ["projectPath", "skillName"]
          }
        },
        {
          name: "req_rule_decision_submit",
          description: "【需求规则池 Builder 规则决策提交】消费 req_rule_pool_build_rule_draft 的 decisionDraftId 和 LLM 解析出的 keptRuleAliases；Builder 只校验 keptRuleAliases ⊆ 规则候选并写规则阶段 receipt，userInput 仅作审计，不参与决策。",
          inputSchema: {
            type: "object",
            properties: {
              projectPath: { type: "string", description: "项目物理路径；用于从 .active-demand 推导需求目录" },
              decisionDraftId: { type: "string", description: "req_rule_pool_build_rule_draft 返回的草案 ID" },
              keptRuleAliases: { type: "array", description: "LLM 根据当前规则确认卡用户回复解析出的保留规则别名数组；空数组表示规则候选全部剔除", items: { type: "string" } },
              userInput: { type: "string", description: "可选审计字段：用户对规则确认卡的原始回复；Builder 不解析该字段" },
              skillName: { type: "string", description: "当前 Skill 名称，必须为 epoint-requirement-analyzer" }
            },
            required: ["projectPath", "decisionDraftId", "keptRuleAliases", "skillName"]
          }
        },
        {
          name: "req_rule_pool_build_table_draft",
          description: "【需求规则池 Builder 表候选草案】Step 6.6 第三阶段。消费规则草案和规则阶段 receipt，只返回表候选 confirmationCard + decisionDraftId；LLM 只展示表候选卡并等待用户表决策。可选传入 Nexbot 精确产品源码查询结果，仅给已存在的候选增加来源说明，不新增候选、不替代用户确认；Nexbot 未安装、不可用、超时或无结果时省略该字段，不能阻断本流程。",
          inputSchema: {
            type: "object",
            properties: {
              projectPath: { type: "string", description: "项目物理路径；用于从 .active-demand 推导需求目录" },
              decisionDraftId: { type: "string", description: "req_rule_pool_build_rule_draft 返回并经规则阶段锁定的草案 ID" },
              nexbotSourceEvidence: {
                type: "array",
                description: "可选；仅传 Nexbot 已精确查到、且能与当前表候选 tableName 或 entityName 对上的产品源码结果。每项只用于附加来源说明，不能创建新候选或自动决定复用；Nexbot 未安装/不可用/超时/无结果时省略，不得因此阻断。queryType 只填 search_symbol 或 search_code。",
                items: {
                  type: "object",
                  properties: {
                    tableName: { type: "string", description: "当前候选中的真实表名；必须精确匹配" },
                    entityName: { type: "string", description: "可选；当前候选中的真实实体名，用于辅助精确匹配" },
                    product: { type: "string", description: "可选；产品或代码库名称" },
                    version: { type: "string", description: "可选；产品版本或版本桶" },
                    queryType: { type: "string", enum: ["search_symbol", "search_code"], description: "实际使用的 Nexbot 查询类型" },
                    query: { type: "string", description: "实际传给 Nexbot 的查询词或符号" },
                    result: { type: "string", description: "Nexbot 返回的短源码事实；不要传 source.path/download_url 作为当前项目路径" }
                  },
                  required: ["tableName", "queryType", "query", "result"]
                }
              },
              skillName: { type: "string", description: "当前 Skill 名称，必须为 epoint-requirement-analyzer" }
            },
            required: ["projectPath", "decisionDraftId", "skillName"]
          }
        },
        {
          name: "req_table_decision_submit",
          description: "【需求规则池 Builder 表决策提交】消费 decisionDraftId 和 LLM 解析出的 keptTableNames/dropAll；Builder 校验表名属于候选并合并规则阶段 receipt，一次性写 rule-pool.json、rule-recall-raw.md、analysis-state.step6_6_ruleRecall 与 submit receipt。",
          inputSchema: {
            type: "object",
            properties: {
              projectPath: { type: "string", description: "项目物理路径；用于从 .active-demand 推导需求目录" },
              decisionDraftId: { type: "string", description: "req_rule_pool_build_rule_draft / req_rule_pool_build_table_draft 贯穿全程的草案 ID" },
              keptTableNames: { type: "array", description: "LLM 根据当前表候选确认卡用户回复解析出的保留表名数组；全部剔除时传空数组并设置 dropAll=true", items: { type: "string" } },
              dropAll: { type: "boolean", description: "是否剔除全部表候选；true 时 keptTableNames 必须为空" },
              userInput: { type: "string", description: "可选审计字段：用户对表候选确认卡的原始回复；Builder 不解析该字段" },
              skillName: { type: "string", description: "当前 Skill 名称，必须为 epoint-requirement-analyzer" }
            },
            required: ["projectPath", "decisionDraftId", "keptTableNames", "dropAll", "skillName"]
          }
        },
        {
          name: "req_stories_submit",
          description: "【需求 User Story 结构化提交】完成 Actor、Story、验收、不变量、可选业务缺口记录、Step 6 决策树和 Step 6.5 业务自审后调用。普通Story只写角色、业务结果和真实验收；exception/boundary/invariants无真实事实时可省略。条件字段使用nextActionCard.authoringContract空槽，稳定ID和追踪账务由系统生成。本工具只接收projectPath和skillName；旧 ambiguityPoints/ambiguityCards 仅作兼容读取，不构成提交门禁。",
          inputSchema: {
            type: "object",
            properties: {
              projectPath: { type: "string", description: "项目物理路径" },
              skillName: { type: "string", description: "当前 Skill 名称，必须为 epoint-requirement-analyzer" }
            },
            required: ["projectPath", "skillName"]
          }
        },
        {
          name: "design_tdd_build_plan",
          description: "【Design TDD 计划 Builder】只传 projectPath（业务项目根，不是 .ai-workspace/project 或需求目录）；Builder 先读取工程导航契约 JSON 与 compact，并以 JSON 为权威校验目录/文件名模板，发现 compact 过期或不完整会在设计阶段自动修复，不能让 Coder 猜文件名。若设计已给出 resolvedPath，Builder 自动从路径取文件名；只有路径和命名合同都缺失时才返回具体字段、来源路径和唯一修复动作。遇到复用表 query-only 列表时，Builder 会在本次调用内自动执行轻量 --reuse-index 刷新，再查询已有分页 Service；刷新失败先尝试旧索引，旧索引也无命中但复用表来源证据齐全时生成只读 Service，并在计划中记录 warning，不把索引工具故障升级成整单阻断。编码模型不需要先准备上下文，也不自行搜索规则。",
          inputSchema: {
            type: "object",
            properties: {
              projectPath: { type: "string", description: "业务项目根目录；必须包含 .ai-workspace/project/.active-demand、设计文档和 scan 产物" }
            },
            required: ["projectPath"]
          }
        },
        {
          name: "design_tdd_skeleton_materialize",
          description: "【Design TDD 骨架物化】一次消费 plan 中全部 owner 文件；Builder 从 plan 机械取得目标文件和模块身份。单个文件物化或登记失败只记录在 failedFiles，后续安全文件继续生成并返回 status=skeleton_partial 与可复制的 retry toolCall；账本已登记的文件会自动跳过，不能删除重物化。所有文件完成后返回 skeleton_completed；客户端重复调用已完成入口时返回同一完成结果，不会重新生成或阻断。",
          inputSchema: {
            type: "object",
            properties: {
              projectPath: { type: "string", description: "项目物理路径；必须已有 .ai-workspace/project scan 产物" }
            },
            required: ["projectPath"]
          }
        },
        {
          name: "scan_reuse_index_refresh",
          description: "【复用卡指路索引刷新 - 用户验收后手动触发】把本轮新增/改名的 Service/Action 回灌 code-reuse-index，让下一轮需求的 reuseCard 能指到它。**finalize 跑通≠用户验收**：本工具不在 finalize 自动跑，必须由使用者在确认本轮代码可验收后显式调用，避免把未验收/将被回退的代码沉淀进索引。指路而非缓存：只刷新接口路径/Action 注入/route 边，不缓存方法签名。",
          inputSchema: {
            type: "object",
            properties: {
              projectPath: { type: "string", description: "项目物理路径；在该项目根下刷新 .ai-workspace/project/code-reuse-index.json" }
            },
            required: ["projectPath"]
          }
        }
        ];
      tools.sort((left, right) => {
        const leftPriority = MAINLINE_MCP_TOOL_PRIORITY_INDEX.has(left.name)
          ? MAINLINE_MCP_TOOL_PRIORITY_INDEX.get(left.name)
          : Number.MAX_SAFE_INTEGER;
        const rightPriority = MAINLINE_MCP_TOOL_PRIORITY_INDEX.has(right.name)
          ? MAINLINE_MCP_TOOL_PRIORITY_INDEX.get(right.name)
          : Number.MAX_SAFE_INTEGER;
        return leftPriority - rightPriority;
      });
      return tools;
    }

  setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return { tools: this.getToolDefinitions() };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params || {};
      return this.executeTool(name, args, request);
    });
  }

  async executeTool(name, args = {}, request = {}) {
      args = args || {};
      this._attachRuntimeUserReply(args, this._extractRuntimeUserReply(request));

      // 工具名归一化：多种 IDE 客户端会给工具名加不同的命名空间前缀，
      // 必须统一剥离回纯工具名（已注册的 MCP 工具常量），否则会误判"工具不存在"。
      // 已知前缀形态：
      //   ① 路径分隔符：'epoint-project-rules/list_rules' / 'epoint-project-rules\\list_rules'
      //   ② 下划线命名空间：'mcp_epoint-project-rules_design_prepare_context'(IDE 渲染时把 server name 拼进工具名)
      //   ③ 点号命名空间：'epoint-project-rules.design_prepare_context'
      const normalizedName = this._normalizeMcpToolName(name);
      if (normalizedName !== name) {
        console.error(`[MCP Debug] Normalized name: ${name} -> ${normalizedName}`);
        name = normalizedName;
      }

      // ★ IDE 客户端入参反序列化兜底：
      // 故事线：某些 IDE(已观察到 Trae 的 run_mcp 包装器)在调用 MCP 工具时，会把整个
      // arguments 对象 JSON.stringify 一次塞进一个名叫 `args` 的字符串字段里发给桥接层，
      // 形态如 { args: "<JSON string>", server_name, tool_name }；某些客户端只字符串化了
      // 部分 array/object 字段，形态如 { decisionRows: "[\"TABLE|...\"]", ... }。
      // 服务端此前直接按 Array.isArray(args.xxx) 判定，Trae 用户每次都被门禁拦截。
      // 这里在工具分发前统一做两层修复：① 解开 {args:"..."} wrapper；② 按工具登记表把
      // 期望是 array/object 但实际是 stringified-JSON 的字段 parse 回原值。修复结果会
      // 通过 args.__mcpStringifiedFieldsCoerced 让下游审计感知到客户端的实际行为。
      args = this._unwrapStringifiedArguments(args);
      args = this._coerceStringifiedJsonValueArgs(name, args);
      args = this._unwrapArrayLikeObjectArgs(name, args);
      if (DESIGN_TDD_CODER_PUBLIC_TOOL_NAMES.has(name) && !this._extractSkillNameFromArgs(args)) {
        Object.defineProperty(args, 'skillName', {
          value: 'epoint-design-tdd-coder',
          enumerable: false,
          configurable: true,
          writable: false
        });
      }

      // 调试日志：输出收到的原始请求(已经过反序列化兜底)
      console.error(`[MCP Debug] Received call: ${name}`, JSON.stringify(args));

        // 工作区归一化：优先按插件显式工作区根归一化；若请求目录是 Maven 子模块且 parent pom
        // 指向兄弟父工程，则提升到共同父目录。无 git/svn 兜底。
        let projectPathNormalization = null;
        if (args && typeof args.projectPath === 'string' && args.projectPath.trim()) {
          const norm = this._normalizeProjectPath(args.projectPath);
          if (norm.changed) {
            projectPathNormalization = {
              originalProjectPath: args.projectPath,
              normalizedProjectPath: norm.normalized,
              workspaceRoot: this.workspaceRoot,
              reason: norm.reason || 'workspace_root',
              evidence: norm.evidence || null,
              originalNormalizedByCwd: norm.originalNormalizedByCwd || ''
            };
            args.projectPath = norm.normalized;
            console.error(`[MCP Debug] projectPath normalized: ${projectPathNormalization.originalProjectPath} -> ${norm.normalized}`);
          }
        }

        try {
          const skillNameRequired = this._requireSkillNameForTool(name, args);
          if (skillNameRequired) return skillNameRequired;

          // 自动激活 Skill：根据 args.skillName 加载对应 policy.json，
          // 让通用 Runtime Guard 物理拦截器生效。详见 skills/_schema/policy-schema.md。
          this._autoActivateSkillIfNeeded(args);

          const toolPolicyGuard = this.skillRuntimeToolGuardService.beforeToolCall(name, args);
          if (toolPolicyGuard) {
            return toolPolicyGuard;
          }
          this._attachRuntimeReferenceRead(
            args,
            this._extractRuntimeReferenceRead(request) || this.skillRuntimeToolGuardService.buildRuntimeReferenceReadContext(name, args)
          );

          if (DESIGN_MANAGED_RUNTIME_ACTION_SET.has(name)) {
            const recovery = this._recoverManagedProjectionTransaction(args.projectPath);
            if (!recovery || recovery.ok !== true) {
              return {
                content: [{ type: "text", text: JSON.stringify({
                  ...recovery,
                  status: 'blocked',
                  allowedNextActions: ['repair_projection_transaction_then_retry_same_action']
                }, null, 2) }],
                isError: true
              };
            }
          }

          const response = await (async () => {
            switch (name) {
            case "rule_expert": {
              const skillNameRequired = this._requireSkillNameForTool(name, args);
              if (skillNameRequired) return skillNameRequired;
              // schema 已拍平（action/ruleName/projectPath 等全在顶层），但历史文档和 Skill reference
              // 里大量示例写的是旧格式 rule_expert(action="read", parameters={ruleName, ...})，
              // LLM 读到后会按旧格式传。入口必须兼容两种格式，不依赖 LLM 全部改口。
              const action = args.action || (args.parameters && args.parameters.action) || undefined;
              const p = args.parameters && typeof args.parameters === 'object' && !Array.isArray(args.parameters)
                ? { ...args.parameters, ...args }
                : args;
              if (!action) {
                return {
                  content: [{
                    type: "text",
                    text: JSON.stringify({
                      ok: false,
                      status: "blocked",
                      actionMode: "repair_rule_expert_read_arguments",
                      errorCode: "RULE_EXPERT_ACTION_MISSING",
                      message: "rule_expert缺少action。读取规则原文请传action=\"read\"，检索规则请传action=\"search\"；规则引用从当前intake的readCatalog取得。",
                      requiredArguments: {
                        action: "read",
                        skillName: args.skillName || "epoint-design-tdd-coder",
                        projectPath: args.projectPath || "<projectPath>",
                        ruleName: args.ruleName || "<ruleName>",
                        outputMode: "full"
                      },
                      repairHint: "按readCatalog中当前任务的规则引用填写ruleName；本地正文已足够时直接读取，不重复调用。",
                      allowedNextActions: ["provide_action_and_rule_reference_then_retry"],
                      forbiddenActions: [
                        "call_rule_expert_without_action",
                        "rewrite_rule_expert_arguments_by_memory",
                        "use_outputMode_snippet_or_summary_for_coder_rule_read"
                      ]
                    }, null, 2)
                  }],
                  isError: true
                };
              }
              switch (action) {
              case "search":
                return { content: [{ type: "text", text: JSON.stringify(this.ruleService.searchRules(p.keyword, p.projectPath), null, 2) }] };
              case "read": {
                const readResult = this._readRuleExpertContent(p);
                const content = readResult.content;
                if (!content) {
                  return { content: [{ type: "text", text: JSON.stringify({ ok: false, ruleName: p.ruleName, versionBucket: p.versionBucket || '', readStatus: 'missing', message: '未找到指定的规范文件' }, null, 2) }] };
                }
                // read 只返回规则正文，不生成旧 Coder 账本或 Planner 快照副作用。
                return { content: [{ type: "text", text: content }] };
              }
              case "analyze":
                // Builder-owned: 自动从 analysis-state.json 读取已确认的模糊点决策，
                // 合并到 userIntent 用于规则检索，解决用户决策信息没加入检索的问题。
                // 同时自动累积 storyId 到 analysis-state.json.storyIds。
                const analyzeProjectPath = String(p.projectPath || args.projectPath || '').trim();
                const analyzeStoryId = String(p.storyId || args.storyId || '').trim();
                let enrichedUserIntent = String(p.userIntent || '').trim();

                if (analyzeProjectPath) {
                  const enrichResult = this._enrichUserIntentWithConfirmedDecisions(analyzeProjectPath, enrichedUserIntent);
                  if (enrichResult) enrichedUserIntent = enrichResult;
                  // 自动累积 storyId 到 analysis-state.json.storyIds（如果 LLM 传了 storyId）
                  if (analyzeStoryId) {
                    this._accumulateStoryIdToState(analyzeProjectPath, analyzeStoryId);
                  }
                }

                const intentResult = this.skillIntentService.intentRecognize(enrichedUserIntent, { projectPath: analyzeProjectPath });
                const ruleAnalyzeResult = this.skillIntentService.buildRequirementRuleAnalyzeResult(enrichedUserIntent, {
                  projectPath: analyzeProjectPath,
                  skillName: args.skillName || p.skillName || p.activeSkill || p.skill || ''
                });
                // 自动落盘 acceptedRules（含 authorityMode/ruleBodyReadRequired 等豁免字段）到 planner-authoring-input.json，
                // 这样 _isScanDerivedRule 等校验函数读到的字段与 analyze 输出一致，AI 不再当搬运工。
                this._persistAcceptedRulesToAuthoringSnapshot(args, ruleAnalyzeResult);
                const hasRuleRecallResult =
                  (Array.isArray(ruleAnalyzeResult && ruleAnalyzeResult.acceptedRules) && ruleAnalyzeResult.acceptedRules.length > 0) ||
                  (Array.isArray(ruleAnalyzeResult && ruleAnalyzeResult.baselineConstraints) && ruleAnalyzeResult.baselineConstraints.length > 0) ||
                  (Array.isArray(ruleAnalyzeResult && ruleAnalyzeResult.unresolvedSignals) && ruleAnalyzeResult.unresolvedSignals.length > 0);
                const shouldSuppressUnmatchedSkillText = Boolean(
                  hasRuleRecallResult &&
                  intentResult &&
                  intentResult._structured &&
                  intentResult._structured.matched === false
                );
                return {
                  content: [{
                    type: "text",
                    text: `${shouldSuppressUnmatchedSkillText ? '' : intentResult.text}${this._formatIntentDiagnostics(intentResult)}${this._formatRequirementRuleAnalyzeResult(ruleAnalyzeResult, { outputMode: p.outputMode })}`
                  }]
                };
              case "execute":
                if (!p || !String(p.ruleName || '').trim() || !String(p.actionName || '').trim()) {
                  return {
                    content: [{
                      type: "text",
                      text: JSON.stringify({
                        ok: false,
                        status: "blocked",
                        actionMode: "use_stage_entry_tool",
                        errorCode: "RULE_EXPERT_EXECUTE_MISSING_ARGS",
                        message: "rule_expert(action=\"execute\") 必须传 ruleName 和 actionName。当前阶段如果是设计/需求/TDD，请直接调用对应阶段入口（设计阶段 design_prepare_context、需求阶段 req_finalize_artifacts、TDD 阶段 design_tdd_skeleton_materialize），不要走 execute 分支。",
                        allowedNextActions: ["call_stage_entry_tool_per_active_skill"],
                        forbiddenActions: ["call_rule_expert_execute_without_ruleName_or_actionName"]
                      }, null, 2)
                    }],
                    isError: true
                  };
                }
                const skillResult = this.skillIntentService.executeSkillAction(p.ruleName, p.actionName, p.params || {});
                return { content: [{ type: "text", text: skillResult }] };
              default:
                return {
                  content: [{
                    type: "text",
                    text: JSON.stringify({
                      ok: false,
                      status: "blocked",
                      actionMode: "repair_rule_expert_action",
                      errorCode: "RULE_EXPERT_ACTION_INVALID",
                      message: `rule_expert action 非法：${action}。允许值：search/read/analyze/execute。Coder 读规则原文使用 action=\"read\" + outputMode=\"full\"。`,
                      allowedActions: ["search", "read", "analyze", "execute"],
                      repairHint: "Coder阶段按当前intake的readCatalog取得规则引用，使用action=\"read\"读取规则正文。",
                      forbiddenActions: [
                        "call_rule_expert_with_unknown_action",
                        "use_outputMode_snippet_or_summary_for_coder_rule_read"
                      ]
                    }, null, 2)
                  }],
                  isError: true
                };
            }
          }

          case "list_rules": {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(this.ruleService.listRules(args.projectPath), null, 2),
                },
              ],
            };
          }

          case "team_rules_search": {
            if (!this.teamRulesService) {
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    error: "team rules index not configured: ensure the vscode plugin's 'Rules Path' is set so .knowledge_repo/knowledge.sqlite gets synced from the team knowledge repo"
                  }, null, 2)
                }]
              };
            }
            const result = this.teamRulesService.search(args.query || "", {
              topK: args.top_k,
              category: args.category || null,
            });
            return {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            };
          }

          case "team_rule_get": {
            if (!this.teamRulesService) {
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    ok: false,
                    error: "team rules index not configured: set the vscode plugin's 'Rules Path' (KNOWLEDGE_REPO_PATH)"
                  }, null, 2)
                }]
              };
            }
            const result = await this.teamRulesService.getRule(args.file_path || "");
            return {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            };
          }

          case "project_scan": {
            const result = await this._handleProjectScan(args);
            return { content: [{ type: "text", text: result }] };
          }

          case "gate_contract": {
            const result = this.gateContractRegistry.resolve(args);
            const responsePayload = String(args && args.outputMode || '').trim().toLowerCase() === 'full'
              ? result
              : this._compactGateContractResult(result);
            return {
              content: [{ type: "text", text: JSON.stringify(responsePayload, null, 2) }],
              isError: result.ok !== true
            };
          }
          case "website_analyze_pages": {
            try {
              const PageCompositionExtractor = require('./modules/page-composition-extractor');
              const payload = PageCompositionExtractor.extract(args.filePaths, args.projectPath);
              const result = PageCompositionExtractor.toMarkdown(payload);
              return { content: [{ type: "text", text: result }] };
            } catch (error) {
              const PageRuleExtractor = require('./modules/page-rule-extractor');
              const legacyResult = PageRuleExtractor.extract(args.filePaths, args.projectPath);
              return {
                content: [{
                  type: "text",
                  text: [
                    '> [!WARNING]',
                    `> page-composition 提取失败，已降级 legacy page-rule-extractor；legacyFallbackUsed=true；error=${error.message}`,
                    '',
                    legacyResult
                  ].join('\n')
                }]
              };
            }
          }

          case "batch_audit_task": {
            const rules = this.aiAgent.discoverRulesFromIntent(args.userIntent || "审计");
            if (!rules.matched) {
              return { content: [{ type: "text", text: "❌ 未能通过意图自动关联到审计规范。您可以尝试输入具体的规范名称。" }] };
            }
            const result = await this.aiAgent.performBatchAudit(
              args.projectPath,
              args.userIntent,
              args.phase || 'audit',
              rules
            );
            return { content: [{ type: "text", text: result }] };
          }

          case "security_audit_task": {
            const rules = this.aiAgent.discoverRulesFromIntent(args.userIntent || "脱敏");
            if (!rules.matched) {
              return { content: [{ type: "text", text: "❌ 未能匹配到脱敏相关规范，请确保已安装对应的 .mdc 文件。" }] };
            }
            const auditResult = await this.aiAgent.securityHandler.handleScan(
              this.aiAgent,
              args.projectPath,
              args.userIntent || "脱敏",
              args.specificRequirements,
              rules
            );
            return { content: [{ type: "text", text: auditResult }] };
          }

          case "compatibility_audit_task": {
            // 委派给国产化适配专家工作流
            const compResult = await this.localizationExpert.execute(
              args.userIntent || "国产化适配",
              args.projectPath,
              args.phase || 'audit',
              args.targetFile
            );
            return { content: [{ type: "text", text: compResult }] };
          }

          case "create_rule": {
            const createResult = this.ruleService.createUserRule({
              ruleName: args.ruleName,
              description: args.description,
              category: args.category,
              intentKeywords: args.intentKeywords,
              ruleContent: args.ruleContent,
              overwrite: args.overwrite
            });
            return {
              content: [{ type: "text", text: JSON.stringify(createResult, null, 2) }],
            };
          }

          case "enhance_prompt": {
            const enhancedContent = PromptEnhancer.enhance(args.originalPrompt);
            return {
              content: [{ type: "text", text: enhancedContent }]
            };
          }

          case "design_tdd_skeleton_materialize": {
            const batchResult = await this._handleDesignTddSkeletonMaterialize(args, {
              reportProgress: this._createMcpProgressReporter(request)
            });
            if (batchResult && batchResult.ok === true) {
              this.skillRuntimeToolGuardService.markDesignTddCoderProject(args.projectPath);
              // 只有整批进入 Vibe Coding 后才清理 Builder 中间产物。
              // skeleton_partial 必须保留账本/施工资料，下一次调用才能只重试失败项。
              if (batchResult.status === 'skeleton_completed' || batchResult.phase === 'vibe_coding') {
                // 物化完成后立即清理 .skeleton-input 中间目录，
                // 不清理会残留在源码树里。
                this._cleanupSkeletonInputDirs(args.projectPath);
              }
            }
            return {
              content: [{ type: "text", text: JSON.stringify(batchResult, null, 2) }],
              isError: batchResult.ok !== true
            };
          }

          case "design_prepare_context": {
            const skillNameRequired = this._requireSkillNameForTool(name, args);
            if (skillNameRequired) return skillNameRequired;
            let workflowResult = await this.designWorkflowService.run(args);
            workflowResult = this._enrichCompletedDesignResult(workflowResult, args.projectPath);
            if (workflowResult.ok === true && workflowResult.designFinalized === true
              && workflowResult.postDesignNextAction?.executionMode !== 'builder_blocked') {
              try {
                const designCleanup = this.designWorkflowService.cleanupCompleted(args.projectPath);
                const designPaths = this._resolveActiveDemandDesignPaths(args.projectPath);
                const workflowCleanup = designCleanup.ok && !designCleanup.skipped && designPaths.ok
                  ? this.designWorkflowArtifactService.cleanupCompletedInputs({ designDir: designPaths.designDir,
                      design: this._readJsonIfExists(designPaths.designJsonPath).value }) : null;
                workflowResult = { ...workflowResult,
                  cleanup: { ...(workflowResult.cleanup || {}), designIntermediates: designCleanup,
                    ...(workflowCleanup ? { workflowInputs: workflowCleanup } : {}) },
                  ...(!designCleanup.ok || workflowCleanup?.ok === false
                    ? { warning: [workflowResult.warning, '设计临时资料清理未完成，下次正常进入时重试。'].filter(Boolean).join(' ') } : {}) };
              } catch (_) {
                workflowResult = { ...workflowResult,
                  warning: [workflowResult.warning, '设计临时资料清理未完成，下次正常进入时重试。'].filter(Boolean).join(' ') };
              }
            }
            return this._designPrepareContextToolResponse(workflowResult);

          }

          case "req_prepare_context":
          case "requirement_analyzer_prepare_context": {
            const feedbackCheck = FeedbackContract.validate(args);
            if (!feedbackCheck.ok) return { content: [{ type: 'text', text: JSON.stringify(feedbackCheck) }], isError: false };
            const skillName = String(args.skillName || '').trim();
            if (skillName !== 'epoint-requirement-analyzer') {
              return {
                content: [{ type: "text", text: JSON.stringify({
                  ok: false,
                  status: "blocked",
                  actionMode: "repair_requirement_anchor",
                  source: "requirement_analyzer_prepare_context",
                  errorCode: "REQUIREMENT_ANALYZER_SKILL_NAME_INVALID",
                  message: "req_prepare_context 只允许 epoint-requirement-analyzer 调用。",
                  allowedNextActions: ["rerun_req_prepare_context_with_epoint_requirement_analyzer_skillName"],
                  forbiddenActions: ["derive_demand_paths_manually", "write_requirement_artifacts_before_req_prepare_context_ok"]
                }, null, 2) }],
                isError: true
              };
            }

            const projectPath = String(args.projectPath || '').trim();
            if (!projectPath) {
              return {
                content: [{ type: "text", text: JSON.stringify({
                  ok: false,
                  status: "blocked",
                  actionMode: "repair_requirement_anchor",
                  source: "requirement_analyzer_prepare_context",
                  errorCode: "REQUIREMENT_ANALYZER_PROJECT_PATH_MISSING",
                  message: "缺少 projectPath，无法锁定需求分析阶段上下文。",
                  allowedNextActions: ["provide_projectPath_then_rerun_req_prepare_context"],
                  forbiddenActions: ["derive_demand_paths_manually", "write_requirement_artifacts_before_req_prepare_context_ok"]
                }, null, 2) }],
                isError: true
              };
            }

            const demandNameForCreate = String(args.demandName || '').trim();
            const requirementPaths = this._resolveActiveDemandRequirementPaths(projectPath, {
              createIfMissing: Boolean(demandNameForCreate),
              demandName: demandNameForCreate,
              forPrepareContext: true,
              requestMode: args.requestMode
            });
            if (!requirementPaths.ok) {
              // 三种 blocked 场景需要不同的 nextActionCard 引导：
              //   ① ACTIVE_DEMAND_MISSING：首跑 demand，引导 LLM 从用户原话派生 demandName 重调
              //   ② ACTIVE_DEMAND_EMPTY：.active-demand 文件被清空，同上
              //   ③ DEMAND_NAME_INVALID：LLM 传了非法 demandName（含日期前缀/绝对路径/含分隔符等）
              // 故事线：截图里 LLM 看到 ACTIVE_DEMAND_MISSING 后误读成 "等用户提供 demandName"，
              // 走到 file_search/AskUserQuestion 自由发挥。修法：blocked 返回里直接给 callTemplate
              // 自驱动模板 + 明确禁令，让 LLM 不再脑补。
              const isMissingOrEmpty = requirementPaths.errorCode === 'REQUIREMENT_FINALIZE_ACTIVE_DEMAND_MISSING'
                  || requirementPaths.errorCode === 'REQUIREMENT_FINALIZE_ACTIVE_DEMAND_EMPTY';
              const isInvalidName = requirementPaths.errorCode === 'REQUIREMENT_FINALIZE_DEMAND_NAME_INVALID';
              const isClosedActiveDemand = requirementPaths.errorCode === 'REQUIREMENT_ACTIVE_DEMAND_ALREADY_CLOSED';
              const isInProgressActiveDemand = requirementPaths.errorCode === 'REQUIREMENT_ACTIVE_DEMAND_IN_PROGRESS';
              const nextActionCard = (isMissingOrEmpty || isInvalidName || isClosedActiveDemand)
                ? {
                    title: isClosedActiveDemand
                      ? '当前 active demand 已闭环 — 新需求需传 demandName 让 Builder 改绑'
                      : (isMissingOrEmpty
                      ? '首次跑该需求 — 从用户首句业务描述派生 demandName 后重调本工具'
                      : 'demandName 不合法 — 修正后重调本工具'),
                    stopAfter: false,
                    instruction: isClosedActiveDemand
                      ? '当前 .active-demand 已有 finalize receipt，说明旧需求阶段已闭环。若当前用户请求是一个新需求，直接从当前用户原话提炼 2-8 字中文业务名，带 demandName 重调 req_prepare_context；Builder 会受控改绑 .active-demand。若用户是要继续旧需求进入设计，则切换到 /epoint-requirement-design，不要手写 .active-demand。'
                      : (isMissingOrEmpty
                      ? '从用户最初的需求描述（chat 里第一句业务相关话）提炼 2-8 字中文业务名（如 "大厅地址管理"、"场所审核"），不含日期前缀（Builder 自动加 yyyy-MM-dd_），直接重调 req_prepare_context。**不要询问用户、不要 file_search/view_folder 探测目录、不要 fs_write 创建 .active-demand**——这些路径都由 Builder 工具创建。只有用户原话连业务名都提炼不出来时才在最后一屏问"本次需求叫什么？2-8 字业务名"。'
                      : 'demandName 含非法字符（不允许 . / .. / 路径分隔符 / 绝对路径 / 日期前缀），请改为 2-8 字纯中文业务名重调。Builder 会自动加 yyyy-MM-dd_ 前缀。'),
                    callTemplate: `req_prepare_context(${JSON.stringify({
                      projectPath,
                      skillName: 'epoint-requirement-analyzer',
                      demandName: 'TEMPLATE_FILL_REQUIRED (2-8 字中文业务名，从用户首句需求描述派生，不含日期前缀)'
                    })})`,
                    afterThisCallSeeNextActionCard: true
                  }
                : null;
              const result = {
                ok: false,
                status: "blocked",
                actionMode: "repair_requirement_anchor",
                source: "requirement_analyzer_prepare_context",
                errorCode: requirementPaths.errorCode,
                message: requirementPaths.message,
                fixedPaths: {
                  activeDemandPath: requirementPaths.activeDemandPath
                },
                ...(requirementPaths.demandName ? { demandName: requirementPaths.demandName } : {}),
                ...(requirementPaths.requestedDemandName ? { requestedDemandName: requirementPaths.requestedDemandName } : {}),
                ...(requirementPaths.closureLevel ? { closureLevel: requirementPaths.closureLevel } : {}),
                ...(requirementPaths.receiptPath ? { receiptPath: requirementPaths.receiptPath } : {}),
                ...(nextActionCard ? { nextActionCard } : {}),
                allowedNextActions: demandNameForCreate
                  ? (isInProgressActiveDemand
                    ? ["continue_current_active_demand_or_finalize_it_before_starting_new_demand"]
                    : ["provide_valid_demandName_then_rerun_req_prepare_context"])
                  : (isClosedActiveDemand
                    ? ["derive_new_demandName_from_current_user_request_then_rerun_req_prepare_context", "switch_to_epoint_requirement_design_if_continuing_closed_demand"]
                    : ["derive_demandName_from_user_request_then_rerun_req_prepare_context"]),
                forbiddenActions: [
                  "derive_demand_paths_manually",
                  "write_requirement_artifacts_before_req_prepare_context_ok",
                  "ask_user_for_demandName_before_attempting_to_derive_from_request",
                  "file_search_for_existing_demand_dir",
                  "view_folder_to_explore_ai_workspace_or_project",
                  "fs_write_active_demand_directly"
                ]
              };
              return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                isError: true
              };
            }

            const fixedPaths = {
              activeDemandPath: requirementPaths.activeDemandPath,
              demandDir: requirementPaths.demandDir,
              demandArtifactDir: requirementPaths.demandArtifactDir,
              demandAnalysisPath: requirementPaths.demandAnalysisPath,
              analysisStatePath: requirementPaths.analysisStatePath,
              ruleRecallRawPath: requirementPaths.ruleRecallRawPath,
              rulePoolPath: requirementPaths.rulePoolPath,
              finalizeReceiptPath: requirementPaths.finalizeReceiptPath
            };
            const analysisStateSkeleton = this.requirementStoriesBuilderService.ensureAnalysisStateSkeleton({
              analysisStatePath: requirementPaths.analysisStatePath,
              demandName: requirementPaths.demandName
            });
            if (!analysisStateSkeleton.ok) {
              return {
                content: [{ type: "text", text: JSON.stringify({
                  ok: false,
                  status: 'blocked',
                  actionMode: 'repair_requirement_analysis_state_storage',
                  errorCode: analysisStateSkeleton.errorCode,
                  message: analysisStateSkeleton.message || 'analysis-state.json 空白骨架未能由 Builder 写入。',
                  fixedPaths,
                  allowedNextActions: ['fix_analysis_state_directory_then_rerun_req_prepare_context'],
                  forbiddenActions: ['write_analysis_state_outside_fixed_path', 'continue_without_analysis_state']
                }, null, 2) }],
                isError: false
              };
            }
            let revisionPrepared = null;
            if (args.requestMode === 'revise') {
              revisionPrepared = this.requirementStoriesBuilderService.prepareRevision({
                analysisStatePath: requirementPaths.analysisStatePath, feedback: args.feedback,
                affectedStoryIds: args.affectedStoryIds });
              if (!revisionPrepared.ok) return { content: [{ type: 'text', text: JSON.stringify(revisionPrepared) }], isError: false };
            } else {
              const pendingState = this._readJsonIfExists(requirementPaths.analysisStatePath);
              if (pendingState.ok && pendingState.value?.revision && pendingState.value.status !== 'done') {
                revisionPrepared = { ok: true, revision: pendingState.value.revision };
              }
            }
            const authoringReadiness = this.requirementStoriesBuilderService.validateAnalysisStateAuthoringForPrepare({
              projectPath,
              paths: requirementPaths
            });
            if (!authoringReadiness.ok) {
              this.skillRuntimeToolGuardService.markRequirementAnalyzerPrepared(projectPath, fixedPaths);
              return {
                content: [{ type: "text", text: JSON.stringify({
                  ...authoringReadiness,
                  fixedPaths,
                }, null, 2) }],
                isError: true
              };
            }
            const artifactPresence = {
              demandAnalysis: fs.existsSync(requirementPaths.demandAnalysisPath),
              analysisState: fs.existsSync(requirementPaths.analysisStatePath),
              ruleRecallRaw: fs.existsSync(requirementPaths.ruleRecallRawPath),
              rulePool: fs.existsSync(requirementPaths.rulePoolPath),
              finalizeReceipt: fs.existsSync(requirementPaths.finalizeReceiptPath)
            };
            const isFirstRun = analysisStateSkeleton.created === true;
            const firstRunInstruction = [
              '本流水线开发后台管理系统；移动端、网站、小程序和 App 界面不在交付范围，只交付其调用的接口。逐 Story 按 nextActionCard.deliveryBoundaryGuide 判断交付方向：普通当前团队后台页面通常省略 deliveryBoundary；外部团队负责 UI、外部系统调用本系统、本系统调用第三方或明确无 UI 时稀疏填写对应值。',
              'Step 1-4.5 静默落盘：识别 Actor、拆 User Story（先辨析系统交互方向：若某个可调用能力的调用者、输入、返回业务结果和失败后果能脱离页面动作单独验收，按独立 Story；若只是页面动作的内部承载，不拆）、补 GWT/不变量、做公司业务机制雷达和业务副作用清单；正文只落到 analysisStatePath。不要为 Story 拆分或补充向用户弹确认卡。',
              '需求分析.md 不在过程态手写，由 req_finalize_artifacts 收口时 Builder 根据 JSON 自动生成。',
              'Builder 已创建合法 analysis-state.json 空白骨架；只在现有 stories 对象内新增 stories.US1 / stories.US2，并增量维护雷达、副作用等业务事实，禁止自创 step2_stories、step3_acceptanceCriteria 等分步根节点。',
              'Step 5 只做可选业务缺口记录，不生成确认卡，不等待用户。',
              '随后完成 Story 业务补全、Step 6 决策树和 authoringContract.step6_5SelfCheck 三问，再直接调用 req_stories_submit；只做业务语义复核：Story边界、业务结果、异常后果、承载方向和条件专项事实，字段存在性、数组、枚举和引用由 Builder 一次校验。',
              '需求阶段只在 Step 6.6 规则/表候选确认卡停下等用户；未决业务事项不猜，留给后续 Coder 在完整骨架上下文中按真实影响提出。'
            ].join(' ');
            const minimalStoryExample = RequirementStoriesBuilderService.MINIMAL_STORY_EXAMPLE;
            const result = {
              ok: true,
              status: "ready",
              actionMode: "consume_fixed_paths",
              source: "requirement_analyzer_prepare_context",
              demandName: requirementPaths.demandName,
              demandDir: requirementPaths.demandDir,
              fixedPaths,
              artifactPresence,
              ...(requirementPaths.activeDemandRebound ? {
                activeDemandRebound: true,
                previousDemandName: requirementPaths.previousDemandName,
                previousDemandClosureLevel: requirementPaths.previousDemandClosure && requirementPaths.previousDemandClosure.closureLevel || ''
              } : {}),
              resumeMode: isFirstRun ? "first_run_analysis_state_ready" : "resume_from_analysis_state",
              ...(revisionPrepared ? { revisionFeedback: revisionPrepared.revision.feedback,
                affectedStoryIds: revisionPrepared.revision.storyIds, revisionPrepared: true,
                idempotentReplay: revisionPrepared.idempotentReplay === true } : {}),
              // prepare 返回当前阶段的最小导航，不把需求分析拆成逐项用户确认流程。
              // 业务缺口留在完整需求和骨架上下文中处理；规则/表候选仍由 Step 6.6 的既有卡片确认。
              nextActionCard: {
                title: isFirstRun
                  ? '需求分析首跑 — 渐进式先做 Step 1-4.5'
                  : '从 analysis-state 恢复 — 按当前 currentStep 续跑',
                stopAfter: false,
                instruction: revisionPrepared
                  ? '按 revisionFeedback 只调整受影响 Story 的业务事实，保留稳定 ID 和无关内容；读 analysis-state 中对应 Story 后增量修改，再 req_stories_submit。复用仍有效的候选确认；候选或覆盖确有变化时才按原规则池合同更新，随后 req_finalize_artifacts，再恢复 Design。不要重做全部需求或另建目录。'
                  : isFirstRun
                  ? firstRunInstruction
                  : '先读 fixedPaths.analysisStatePath 的 analysis-state.json，结合 currentStep/stepStatus 续跑。',
                minimalExample: minimalStoryExample,
                authoringContract: RequirementStoriesBuilderService.PREPARE_AUTHORING_CONTRACT,
                deliveryBoundaryGuide: RequirementStoriesBuilderService.DELIVERY_BOUNDARY_GUIDE,
                afterThisCallSeeNextActionCard: true
              },
              allowedNextActions: [
                "consume_fixedPaths_only",
                "read_active_demand_by_fixedPath",
                "write_only_to_fixedPaths",
                "update_builder_created_analysis_state_by_fixedPath",
                "append_requirement_analysis_by_fixedPath",
                "after_step_4_5_record_optional_business_gaps_then_author_stories",
                "call_req_finalize_artifacts_after_state_done"
              ],
              forbiddenActions: [
                "derive_demand_paths_manually",
                "search_for_demand_artifacts",
                "write_to_projectPath_demand_name_demand",
                "write_requirement_artifacts_outside_fixedPaths",
                "ask_user_to_confirm_story_split_before_step_5",
                "ask_user_whether_to_supplement_story_before_step_5",
                "stop_silent_landing_at_step_2_for_user_confirmation",
                "invent_business_answers_for_unresolved_gaps",
                "turn_implementation_details_into_requirement_questions"
              ]
            };
            this.skillRuntimeToolGuardService.markRequirementAnalyzerPrepared(projectPath, fixedPaths);
            return {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
              isError: false
            };
          }

          case "req_finalize_artifacts":
          case "requirement_analyzer_finalize_artifacts": {
            const skillNameRequired = this._requireSkillNameForTool(name, args);
            if (skillNameRequired) return skillNameRequired;
            const projectPath = String(args.projectPath || '').trim();
            if (!projectPath) {
              return {
                content: [{ type: "text", text: JSON.stringify({ ok: false, status: "blocked", message: "缺少 projectPath 参数" }) }],
                isError: true
              };
            }

            const requirementPaths = this._resolveActiveDemandRequirementPaths(projectPath);
            if (!requirementPaths.ok) {
              return {
                content: [{ type: "text", text: JSON.stringify({
                  ok: false,
                  status: "blocked",
                  actionMode: "repair_requirement_anchor",
                  errorCode: requirementPaths.errorCode,
                  message: requirementPaths.message,
                  activeDemandPath: requirementPaths.activeDemandPath,
                  allowedNextActions: ['restore_active_demand_then_rerun_req_finalize_artifacts'],
                  forbiddenActions: ['final_answer_before_requirement_artifacts_verified']
                }, null, 2) }],
                isError: false
              };
            }

            let analysisState = null;
            try {
              analysisState = JSON.parse(fs.readFileSync(requirementPaths.analysisStatePath, 'utf-8'));
            } catch (error) {
              return {
                content: [{ type: "text", text: JSON.stringify({
                  ok: false,
                  status: "blocked",
                  actionMode: "repair_requirement_artifacts",
                  errorCode: "REQUIREMENT_ANALYSIS_STATE_INVALID",
                  message: `需求分析状态文件缺失或无法解析：${requirementPaths.analysisStatePath}`,
                  cause: String(error && error.message || error),
                  allowedNextActions: ['repair_analysis_state_then_rerun_req_finalize_artifacts'],
                  forbiddenActions: ['final_answer_before_requirement_artifacts_verified']
                }, null, 2) }],
                isError: false
              };
            }

            // AGENTS.md "确定事实不进 LLM 视野" 红线：
            //   analysis-state.status 由 Builder 在 finalize 跑通时自动标 done，不要求 LLM 手维护。
            //   只要 analysisState / stories.json / rulePool / ruleRecallRaw 闭合 +
            //   rule pool validation 通过，就视为 done-like。需求分析.md 是收口时由 Builder 生成的人读展示。
            //   历史上的 REQUIREMENT_ANALYSIS_STATE_NOT_DONE 校验和
            //   REQUIREMENT_STORIES_STATE_STORYIDS_MISMATCH 校验已废除，避免让 LLM 维护派生字段。

            let rulePoolValidation = { ok: false, summary: null };
            let unresolvedSignals = [];
            let requirementRulePool = null;
            try {
              requirementRulePool = JSON.parse(fs.readFileSync(requirementPaths.rulePoolPath, 'utf-8'));
            } catch (error) {
              return {
                content: [{ type: "text", text: JSON.stringify({
                  ok: false,
                  status: "blocked",
                  actionMode: "repair_requirement_rule_pool",
                  errorCode: "REQUIREMENT_RULE_POOL_INVALID_JSON",
                  message: `需求规则池文件缺失或无法解析：${requirementPaths.rulePoolPath}`,
                  cause: String(error && error.message || error),
                  allowedNextActions: ['repair_requirement_rule_pool_then_rerun_req_finalize_artifacts'],
                  forbiddenActions: ['final_answer_before_requirement_artifacts_verified']
                }, null, 2) }],
                isError: false
              };
            }
            const demandAnalysisText = fs.existsSync(requirementPaths.demandAnalysisPath)
              ? fs.readFileSync(requirementPaths.demandAnalysisPath, 'utf-8')
              : '';

              // stories.json Builder receipt 校验：req_stories_submit 必须已经走过，
              // 否则手写 storyIds / 自由格式 §2-§4 段落都会被拦下。设计阶段 design Builder
              // 直接消费 stories.json，没有这份机器合同就不能进入设计。
              const storiesValidation = this.requirementStoriesBuilderService.validateSubmitReceipt({
                projectPath,
                storiesPath: requirementPaths.storiesPath,
                storiesReceiptPath: requirementPaths.storiesReceiptPath,
                analysisStatePath: requirementPaths.analysisStatePath
              });
              if (!storiesValidation.ok) {
                return {
                  content: [{ type: "text", text: JSON.stringify({
                    ok: false,
                    status: "blocked",
                    actionMode: "rerun_req_stories_submit",
                    errorCode: storiesValidation.code,
                    message: storiesValidation.message,
                    issues: storiesValidation.issues || [],
                    nextActionCard: storiesValidation.nextActionCard,
                    allowedNextActions: ['rerun_req_stories_submit_then_rerun_req_finalize_artifacts'],
                    forbiddenActions: ['final_answer_before_requirement_artifacts_verified', 'write_stories_json_directly']
                  }, null, 2) }],
                  isError: false
                };
              }

              // analysis-state.storyIds 不再校验：已在 req_stories_submit Builder 中废止合回，
              // stories.json 是 storyIds 的唯一真值源，rule pool validation 直接消费。

              // Builder receipt 校验前移，无条件强校验：手写 rule-pool.json（无 managedBy）一律 blocked。
              // validateSubmitReceipt 内部按 ①managedBy ②receipt 存在 ③receipt status ④hash 顺序校验。
              const receiptValidation = this.requirementRulePoolBuilderService.validateSubmitReceipt({
                rulePoolPath: requirementPaths.rulePoolPath,
                receiptPath: path.join(requirementPaths.demandArtifactDir, 'rule-pool-submit-receipt.json')
              });
              if (!receiptValidation.ok) {
                return {
                  content: [{ type: "text", text: JSON.stringify({
                    ok: false,
                    status: "blocked",
                    actionMode: "rerun_req_rule_pool_build_rule_draft_then_submit_rule_decision_then_build_table_draft_then_submit_table_decision",
                    errorCode: receiptValidation.code,
                    message: receiptValidation.message,
                    allowedNextActions: ['rerun_req_rule_pool_build_rule_draft_then_submit_rule_decision_then_build_table_draft_then_submit_table_decision'],
                    forbiddenActions: ['final_answer_before_requirement_artifacts_verified', 'write_rule_pool_json_directly', 'set_rule_pool_confirmed_true_manually']
                  }, null, 2) }],
                  isError: false
                };
              }
              rulePoolValidation = this.requirementRulePoolService.validateRulePool(
                requirementRulePool,
                demandAnalysisText,
                {
                  sourcePath: requirementPaths.rulePoolPath,
                  analysisState: analysisState || null,
                  // AGENTS.md "确定事实不进 LLM 视野"：storyIds 真值源是 stories.json
                  storyIds: storiesValidation && storiesValidation.stories && storiesValidation.stories.storyIds
                }
              );
              if (!rulePoolValidation.ok) {
                return {
                  content: [{ type: "text", text: JSON.stringify({
                    ok: false,
                    status: "blocked",
                    actionMode: "repair_requirement_rule_pool",
                    errorCode: "REQUIREMENT_RULE_POOL_VALIDATION_FAILED",
                    message: "需求规则池未确认或未覆盖全部 User Story，禁止宣称需求分析完成并进入设计。",
                    requirementRulePoolLayer: {
                      ok: false,
                      issueCount: rulePoolValidation.issueCount,
                      sampleIssues: rulePoolValidation.issues.slice(0, 8)
                    },
                    allowedNextActions: ['repair_requirement_rule_pool_then_rerun_req_finalize_artifacts'],
                    forbiddenActions: ['final_answer_before_requirement_artifacts_verified']
                  }, null, 2) }],
                  isError: false
                };
              }
            unresolvedSignals = this._requirementRulePoolUnresolvedSignals(rulePoolValidation.summary || {});

            // AGENTS.md "确定事实不进 LLM 视野"：所有上游产物校验都通过后，
            // Builder 自动给 analysis-state.json 标 status: 'done' + currentStep: 'completed'，
            // 不让 LLM 手维护这个派生状态字段。
            // 注意：这一步必须在 verifyAndWriteReceipt 之前，因为 receipt 会对落盘内容计算 hash。
            try {
              const stateForUpdate = analysisState && typeof analysisState === 'object' && !Array.isArray(analysisState)
                ? { ...analysisState }
                : {};
              stateForUpdate.status = 'done';
              stateForUpdate.currentStep = 'completed';
              fs.writeFileSync(
                requirementPaths.analysisStatePath,
                JSON.stringify(stateForUpdate, null, 2),
                'utf-8'
              );
              analysisState = stateForUpdate;
            } catch (error) {
              return {
                content: [{ type: "text", text: JSON.stringify({
                  ok: false,
                  status: "blocked",
                  actionMode: "repair_requirement_artifacts",
                  errorCode: "REQUIREMENT_ANALYSIS_STATE_AUTO_MARK_DONE_FAILED",
                  message: `Builder 自动标记 analysis-state.json done 失败：${error.message}`,
                  allowedNextActions: ['rerun_req_finalize_artifacts'],
                  forbiddenActions: ['fs_write_analysis_state_status_directly']
                }, null, 2) }],
                isError: false
              };
            }

            // 人读展示在阶段收口时由 Builder 统一生成。需求阶段过程态只要求 LLM 维护
            // analysis-state.json；stories.json / rule-pool.json 是机器合同，需求分析.md
            // 是由这些合同渲染出来的最终报告，避免 LLM 同步维护 Markdown + JSON 两份事实。
            try {
              this._renderAndWriteRequirementAnalysisMarkdown(requirementPaths, analysisState);
            } catch (error) {
              return {
                content: [{ type: "text", text: JSON.stringify({
                  ok: false,
                  status: "blocked",
                  actionMode: "repair_requirement_artifacts",
                  errorCode: "REQUIREMENT_ANALYSIS_MARKDOWN_RENDER_FAILED",
                  message: `Builder 生成需求分析.md 失败：${error.message}`,
                  allowedNextActions: ['repair_analysis_state_or_stories_then_rerun_req_finalize_artifacts'],
                  forbiddenActions: ['fs_write_demand_analysis_md_directly']
                }, null, 2) }],
                isError: false
              };
            }

            const finalizeResult = this.managedArtifactFinalizerService.verifyAndWriteReceipt({
              stageKey: 'requirement-analyzer',
              actionMode: 'verify_final_requirement_artifacts_by_fixed_paths',
              rootDir: requirementPaths.demandDir,
              receiptPath: requirementPaths.finalizeReceiptPath,
              artifacts: [
                {
                  key: 'demandAnalysis',
                  type: 'text',
                  path: requirementPaths.demandAnalysisPath
                },
                {
                  key: 'analysisState',
                  type: 'json',
                  path: requirementPaths.analysisStatePath
                },
                {
                  key: 'ruleRecallRaw',
                  type: 'text',
                  path: requirementPaths.ruleRecallRawPath
                },
                {
                  key: 'rulePool',
                  type: 'json',
                  path: requirementPaths.rulePoolPath
                }
              ],
              receiptExtra: {
                demandName: requirementPaths.demandName,
                requirementRulePoolSummary: rulePoolValidation.summary
              },
              allowedNextActions: ['confirm_requirement_artifacts_verified_then_continue_to_design'],
              verifyFailureNextActions: ['repair_requirement_artifacts_then_rerun_req_finalize_artifacts'],
              writeFailureNextActions: ['fix_demand_directory_permission_then_rerun_req_finalize_artifacts'],
              forbiddenActions: ['final_answer_before_requirement_artifacts_verified']
            });
            const requirementCleanup = finalizeResult.ok === true
              ? this._cleanupRequirementFinalizeIntermediates(requirementPaths)
              : null;
            const result = finalizeResult.ok === true
              ? {
                  ...finalizeResult,
                  written: {
                    demandAnalysisPath: requirementPaths.demandAnalysisPath,
                    analysisStatePath: requirementPaths.analysisStatePath,
                    ruleRecallRawPath: requirementPaths.ruleRecallRawPath,
                    rulePoolPath: requirementPaths.rulePoolPath
                  },
                  demandName: requirementPaths.demandName,
                  demandDir: requirementPaths.demandDir,
                  qualityScope: {
                    validationKind: 'structure_and_receipt_only',
                    unresolvedSignalNames: unresolvedSignals.map(item => item.signal).filter(Boolean).slice(0, 8),
                    unresolvedSignalsAdvisoryOnly: true
                  },
                  cleanup: {
                    requirementIntermediates: requirementCleanup
                  },
                  ...(requirementCleanup?.ok === false
                    ? { warning: '需求临时资料清理未完成，下次正常收口时重试。' } : {}),
                  nextActionCard: {
                    title: '需求阶段结构验收通过 — 按 /epoint-requirement-design 接力',
                    stopAfter: false,
                  instruction: unresolvedSignals.length > 0
                      ? 'req_finalize_artifacts ok=true 代表固定路径、结构、Builder 凭证和 hash 已验收，并已由 Builder 生成需求分析.md。rule-pool.json 中的 unresolvedSignals 仅作为规则召回提示项，不阻断 /epoint-requirement-design 或 Coder；后续不得把提示项伪造成已确认规则。最终接力卡若 rule-pool.json.globalTableCandidateWhitelist[] 已确认复用表，不要再写"表名待提供"。下一阶段只写 /epoint-requirement-design 继续，不要套用旧模板里的下一阶段产物名。'
                      : 'req_finalize_artifacts ok=true 代表固定路径、结构、Builder 凭证和 hash 已验收，并已由 Builder 生成需求分析.md。最终接力卡若 rule-pool.json.globalTableCandidateWhitelist[] 已确认复用表，不要再写"表名待提供"。下一阶段只写 /epoint-requirement-design 继续，不要套用旧模板里的下一阶段产物名。'
                  },
                  ...(unresolvedSignals.length > 0 ? { unresolvedSignals } : {})
                }
              : {
                  ...finalizeResult,
                  actionMode: finalizeResult.actionMode || 'repair_requirement_artifacts',
                  errorCode: {
                    MANAGED_ARTIFACT_VERIFY_FAILED: 'REQUIREMENT_FINALIZE_ARTIFACT_VERIFY_FAILED',
                    MANAGED_ARTIFACT_RECEIPT_WRITE_FAILED: 'REQUIREMENT_FINALIZE_RECEIPT_WRITE_FAILED'
                  }[finalizeResult.errorCode] || finalizeResult.errorCode || 'REQUIREMENT_FINALIZE_ARTIFACT_FAILED',
                  forbiddenActions: ['final_answer_before_requirement_artifacts_verified']
                };
            return {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
              isError: false
            };
          }

          case "req_rule_pool_build_rule_draft": {
            const skillNameRequired = this._requireSkillNameForTool(name, args);
            if (skillNameRequired) return skillNameRequired;
            const projectPath = String(args.projectPath || '').trim();
            if (!projectPath) {
              return {
                content: [{ type: "text", text: JSON.stringify({ ok: false, status: "blocked", message: "缺少 projectPath 参数" }) }],
                isError: true
              };
            }
            const requirementPaths = this._resolveActiveDemandRequirementPaths(projectPath);
            if (!requirementPaths.ok) {
              return {
                content: [{ type: "text", text: JSON.stringify({
                  ok: false,
                  status: "blocked",
                  actionMode: "repair_requirement_anchor",
                  errorCode: requirementPaths.errorCode,
                  message: requirementPaths.message,
                  activeDemandPath: requirementPaths.activeDemandPath,
                  allowedNextActions: ['restore_active_demand_then_rerun_req_rule_pool_build_rule_draft'],
                  forbiddenActions: ['write_rule_pool_json_directly']
                }, null, 2) }],
                isError: false
              };
            }
            // 前置校验：stories.json 必须先生成。
            // 故事线：旧版本走 _extractStories 的 markdown 兜底路径，从 需求分析.md 用正则
            // 抽 storyId + 一句话叙事，意图文本只剩 ~12 字（如"User Story US1\n场所新增"），
            // 规则库里"代码项""SelectItem""DataGrid"等关键词全部漏召（dump 显示 7 个 Story
            // 只命中 1 条规则）。修法：意图检索前强校验 stories.json 存在；不存在直接 blocked
            // + nextActionCard 引导先调 req_stories_submit。
            // 设计意图：stories.json 是需求阶段的结构化机器合同（GWT 三组 + invariants），
            // 召回意图文本依赖它才能展开足够信号。
            const storiesValidation = this.requirementStoriesBuilderService.validateSubmitReceipt({
              projectPath,
              storiesPath: requirementPaths.storiesPath,
              storiesReceiptPath: requirementPaths.storiesReceiptPath,
              analysisStatePath: requirementPaths.analysisStatePath
            });
            if (!storiesValidation.ok) {
              return {
                content: [{ type: "text", text: JSON.stringify({
                  ok: false,
                  status: "blocked",
                  actionMode: "submit_stories_before_rule_pool_draft",
                  errorCode: storiesValidation.code === 'REQUIREMENT_STORIES_FILE_MISSING'
                    ? "REQUIREMENT_RULE_POOL_DRAFT_STORIES_NOT_SUBMITTED"
                    : storiesValidation.code,
                  message: storiesValidation.message,
                  issues: storiesValidation.issues || [],
                  fixedPaths: { storiesPath: requirementPaths.storiesPath },
                  nextActionCard: {
                    title: "Step 5.5 漏跑 — 先调 req_stories_submit 写入结构化 Story 产物",
                    stopAfter: false,
                    instruction: "先按 analysis-state.json 的 currentStep/stepStatus 完成 Step 5.5 Story业务补全、Step 6决策树和 authoringContract.step6_5SelfCheck 三问，再调 req_stories_submit。普通Story只写actor、userStory和至少一条happyPath；exception/boundary/invariants有真实事实才写。条件字段严格使用authoringContract空槽；稳定ID和追踪账务由Builder生成。禁止手写stories.json或跳过提交。",
                    minimalExample: RequirementStoriesBuilderService.MINIMAL_STORY_EXAMPLE,
                    authoringContract: RequirementStoriesBuilderService.AUTHORING_CONTRACT,
                    callTemplate: `req_stories_submit(${JSON.stringify({
                      projectPath,
                      skillName: 'epoint-requirement-analyzer'
                    })})`,
                    afterThisCallSeeNextActionCard: true
                  },
                  allowedNextActions: [
                    'call_req_stories_submit_from_analysis_state_then_rerun_req_rule_pool_build_rule_draft'
                  ],
                  forbiddenActions: [
                    'call_req_rule_pool_build_rule_draft_before_stories_submitted',
                    'fs_write_stories_json_directly',
                    'derive_structured_stories_from_generated_demand_markdown'
                  ]
                }, null, 2) }],
                isError: false
              };
            }
            const result = this.requirementRulePoolBuilderService.buildRuleDraft({
              projectPath,
              userSupplement: String(args.userSupplement || args.additionalIntent || '').trim(),
              userSupplementTableNames: args.userSupplementTableNames,
              paths: requirementPaths
            });
            return {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
              isError: result.ok !== true
            };
          }

          case "req_rule_decision_submit": {
            const skillNameRequired = this._requireSkillNameForTool(name, args);
            if (skillNameRequired) return skillNameRequired;
            const projectPath = String(args.projectPath || '').trim();
            const decisionDraftId = String(args.decisionDraftId || '').trim();
            if (!projectPath || !decisionDraftId || !Array.isArray(args.keptRuleAliases)) {
              return {
                content: [{ type: "text", text: JSON.stringify({
                  ok: false,
                  status: "blocked",
                  actionMode: "repair_requirement_rule_pool_builder_input",
                  errorCode: "REQUIREMENT_RULE_POOL_SUBMIT_RULE_ARGS_MISSING",
                  message: "req_rule_decision_submit 缺少 projectPath / decisionDraftId / keptRuleAliases。",
                  allowedNextActions: ['rerun_req_rule_pool_build_rule_draft_or_collect_rule_confirmation'],
                  forbiddenActions: ['write_rule_pool_json_directly']
                }, null, 2) }],
                isError: false
              };
            }
            const requirementPaths = this._resolveActiveDemandRequirementPaths(projectPath);
            if (!requirementPaths.ok) {
              return {
                content: [{ type: "text", text: JSON.stringify({
                  ok: false,
                  status: "blocked",
                  actionMode: "repair_requirement_anchor",
                  errorCode: requirementPaths.errorCode,
                  message: requirementPaths.message,
                  activeDemandPath: requirementPaths.activeDemandPath,
                  allowedNextActions: ['restore_active_demand_then_rerun_req_rule_decision_submit'],
                  forbiddenActions: ['write_rule_pool_json_directly']
                }, null, 2) }],
                isError: false
              };
            }
            const result = this.requirementRulePoolBuilderService.submitRuleDecision({
              projectPath,
              decisionDraftId,
              keptRuleAliases: args.keptRuleAliases,
              userInput: String(args.userInput || args.userDecision || '').trim(),
              paths: requirementPaths
            });
            return {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
              isError: result.ok !== true
            };
          }

          case "req_rule_pool_build_table_draft": {
            const skillNameRequired = this._requireSkillNameForTool(name, args);
            if (skillNameRequired) return skillNameRequired;
            const projectPath = String(args.projectPath || '').trim();
            const decisionDraftId = String(args.decisionDraftId || '').trim();
            if (!projectPath || !decisionDraftId) {
              return {
                content: [{ type: "text", text: JSON.stringify({ ok: false, status: "blocked", message: "req_rule_pool_build_table_draft 缺少 projectPath / decisionDraftId。" }) }],
                isError: false
              };
            }
            const requirementPaths = this._resolveActiveDemandRequirementPaths(projectPath);
            if (!requirementPaths.ok) {
              return {
                content: [{ type: "text", text: JSON.stringify({
                  ok: false,
                  status: "blocked",
                  actionMode: "repair_requirement_anchor",
                  errorCode: requirementPaths.errorCode,
                  message: requirementPaths.message,
                  activeDemandPath: requirementPaths.activeDemandPath,
                  allowedNextActions: ['restore_active_demand_then_rerun_req_rule_pool_build_table_draft'],
                  forbiddenActions: ['write_rule_pool_json_directly']
                }, null, 2) }],
                isError: false
              };
            }
            const result = this.requirementRulePoolBuilderService.buildTableDraft({
              projectPath,
              decisionDraftId,
              nexbotSourceEvidence: args.nexbotSourceEvidence,
              paths: requirementPaths
            });
            return {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
              isError: result.ok !== true
            };
          }

          case "req_table_decision_submit": {
            const skillNameRequired = this._requireSkillNameForTool(name, args);
            if (skillNameRequired) return skillNameRequired;
            const projectPath = String(args.projectPath || '').trim();
            const decisionDraftId = String(args.decisionDraftId || '').trim();
            if (!projectPath || !decisionDraftId || !Array.isArray(args.keptTableNames) || typeof args.dropAll !== 'boolean') {
              return {
                content: [{ type: "text", text: JSON.stringify({
                  ok: false,
                  status: "blocked",
                  actionMode: "repair_requirement_rule_pool_builder_input",
                  errorCode: "REQUIREMENT_RULE_POOL_SUBMIT_TABLE_ARGS_MISSING",
                  message: "req_table_decision_submit 缺少 projectPath / decisionDraftId / keptTableNames / dropAll。",
                  allowedNextActions: ['rerun_req_rule_pool_build_table_draft_or_collect_table_confirmation'],
                  forbiddenActions: ['write_rule_pool_json_directly']
                }, null, 2) }],
                isError: false
              };
            }
            const requirementPaths = this._resolveActiveDemandRequirementPaths(projectPath);
            if (!requirementPaths.ok) {
              return {
                content: [{ type: "text", text: JSON.stringify({
                  ok: false,
                  status: "blocked",
                  actionMode: "repair_requirement_anchor",
                  errorCode: requirementPaths.errorCode,
                  message: requirementPaths.message,
                  activeDemandPath: requirementPaths.activeDemandPath,
                  allowedNextActions: ['restore_active_demand_then_rerun_req_table_decision_submit'],
                  forbiddenActions: ['write_rule_pool_json_directly']
                }, null, 2) }],
                isError: false
              };
            }
            const result = this.requirementRulePoolBuilderService.submitTableDecision({
              projectPath,
              decisionDraftId,
              keptTableNames: args.keptTableNames,
              dropAll: args.dropAll,
              userInput: String(args.userInput || args.userDecision || '').trim(),
              paths: requirementPaths
            });
            if (result && result.ok === true && result.status === 'ready') {
                const unresolvedSignalNames = Array.isArray(result.summary && result.summary.unresolvedSignalNames)
                    ? result.summary.unresolvedSignalNames.filter(Boolean)
                    : [];
                const unresolvedClause = unresolvedSignalNames.length > 0
                    ? `rule-pool.json 记录了 unresolvedSignals：${unresolvedSignalNames.join('、')}；它们只是规则召回提示项，不阻断 finalize/设计/Coder，最终接力卡可简要披露，后续不得冒名成已确认规则。`
                    : 'rule-pool.json 未记录 unresolvedSignals。';
                result.nextActionCard = {
                    title: 'rule-pool.json 已确认落盘 — finalize 前自审后再完成需求分析',
                    stopAfter: false,
                    instruction: `stories.json、analysis-state.json、rule-pool.json 已齐。finalize 前自审：1) ${unresolvedClause} 2) 对照 rule-pool.json.globalTableCandidateWhitelist[]，若表候选已确认，最终接力卡不得继续写"表名待提供"。3) 确认用户原话中的实现偏好只留在rawUserReply / implementationPreferenceAuditOnly，Story只保留可验收业务事实；既有入口只通过existingAdjustment交接。自审后调req_finalize_artifacts；Builder生成需求分析.md。未收到ok=true前禁止宣称完成。`,
                    nextToolCallTemplate: `req_finalize_artifacts(${JSON.stringify({
                        projectPath,
                        skillName: 'epoint-requirement-analyzer'
                    })})`
                };
            }
            return {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
              isError: result.ok !== true
            };
          }

          case "req_stories_submit": {
            const skillNameRequired = this._requireSkillNameForTool(name, args);
            if (skillNameRequired) return skillNameRequired;
            const projectPath = String(args.projectPath || '').trim();
            if (!projectPath) {
              return {
                content: [{ type: "text", text: JSON.stringify({
                  ok: false,
                  status: "blocked",
                  actionMode: "repair_requirement_stories_input",
                  errorCode: "REQUIREMENT_STORIES_SUBMIT_PROJECT_PATH_MISSING",
                  message: "req_stories_submit 缺少 projectPath。",
                  allowedNextActions: ['rerun_req_stories_submit_with_projectPath']
                }, null, 2) }],
                isError: true
              };
            }
            const requirementPaths = this._resolveActiveDemandRequirementPaths(projectPath);
            if (!requirementPaths.ok) {
              return {
                content: [{ type: "text", text: JSON.stringify({
                  ok: false,
                  status: "blocked",
                  actionMode: "repair_requirement_anchor",
                  errorCode: requirementPaths.errorCode,
                  message: requirementPaths.message,
                  activeDemandPath: requirementPaths.activeDemandPath,
                  allowedNextActions: ['restore_active_demand_then_rerun_req_stories_submit'],
                  forbiddenActions: ['write_stories_json_directly']
                }, null, 2) }],
                isError: false
              };
            }
            // 前置校验：req_stories_submit 之前 Step 1-5.5 必须已经把 Story 业务事实
            // 落盘到 analysis-state.json，不能只在对话里说就直接 submit。
            // 故事线：实测 LLM 把 Actor 表/Story 表/GWT/不变量全写在对话里没真 fs_write，
            if (Object.prototype.hasOwnProperty.call(args, 'stories')) {
              return {
                content: [{ type: "text", text: JSON.stringify({
                  ok: false,
                  status: "blocked",
                  actionMode: "repair_req_stories_submit_call",
                  errorCode: "REQUIREMENT_STORIES_SUBMIT_STORIES_ARG_FORBIDDEN",
                  message: "req_stories_submit 不接收 stories 入参；请先修 analysis-state.json.stories，再只传 projectPath + skillName 重调本工具。",
                  nextActionCard: {
                    title: "移除 stories 入参后重调 req_stories_submit",
                    stopAfter: false,
                    instruction: "Story 业务判断只落在 analysis-state.json.stories；不要在工具调用里重拼 stories[]。修完 analysis-state 后按 callTemplate 重调。",
                    callTemplate: `req_stories_submit(${JSON.stringify({
                      projectPath,
                      skillName: 'epoint-requirement-analyzer'
                    })})`
                  },
                  allowedNextActions: ['repair_analysis_state_stories_then_rerun_req_stories_submit'],
                  forbiddenActions: ['pass_stories_arg_to_req_stories_submit', 'write_stories_json_directly']
                }, null, 2) }],
                isError: true
              };
            }
            // 拿着对话内容直接调 req_stories_submit 而没有先把 analysis-state 落盘，会导致
            // stories.json 无法物化。需求分析.md 不再作为过程态前置条件，finalize 时由 Builder
            // 根据 analysis-state.json / stories.json / rule-pool.json 统一生成。
            if (!fs.existsSync(requirementPaths.analysisStatePath)) {
              const missing = ['analysis-state.json'];
              return {
                content: [{ type: "text", text: JSON.stringify({
                  ok: false,
                  status: "blocked",
                  actionMode: "repair_requirement_artifacts",
                  errorCode: "REQUIREMENT_STORIES_SUBMIT_UPSTREAM_ARTIFACTS_MISSING",
                  message: `缺少 ${missing.join(' + ')}。请先调用 req_prepare_context，让 Builder 在固定路径创建 analysis-state.json 空白骨架；随后只在该骨架的 stories 对象内增量写入业务事实。`,
                  fixedPaths: {
                    analysisStatePath: requirementPaths.analysisStatePath
                  },
                  missingArtifacts: missing,
                  nextActionCard: {
                    title: '先调用 req_prepare_context 创建 analysis-state.json 空白骨架',
                    stopAfter: false,
                    instruction: `调用 req_prepare_context({projectPath, skillName:"epoint-requirement-analyzer"})，由 Builder 创建 \`${requirementPaths.analysisStatePath}\`。不要手写根文件；prepare 成功后只用 str_replace 在现有 stories 对象内写 stories.US1 / stories.US2 及其 acceptanceCriteria、invariants 和业务事实。`,
                    minimalExample: RequirementStoriesBuilderService.MINIMAL_STORY_EXAMPLE,
                    authoringContract: RequirementStoriesBuilderService.AUTHORING_CONTRACT,
                    callTemplate: `req_prepare_context(${JSON.stringify({
                      projectPath,
                      skillName: 'epoint-requirement-analyzer'
                    })})`
                  },
                  allowedNextActions: ['call_req_prepare_context_then_update_stories_then_rerun_req_stories_submit'],
                  forbiddenActions: [
                    'submit_stories_without_analysis_state_landing',
                    'rely_on_chat_content_to_replace_file_landing',
                    'skip_step_1_to_5_5_analysis_state_write',
                    'fs_write_analysis_state_root_directly',
                    'fs_write_demand_analysis_md_directly'
                  ]
                }, null, 2) }],
                isError: false
              };
            }
            const rootValidation = this.requirementStoriesBuilderService.validateAnalysisStateRoot({
              projectPath,
              paths: requirementPaths
            });
            if (!rootValidation.ok) {
              return {
                content: [{ type: "text", text: JSON.stringify(rootValidation, null, 2) }],
                isError: false
              };
            }
            const submitArgs = {
              projectPath,
              paths: requirementPaths
            };
            const result = this.requirementStoriesBuilderService.submit(submitArgs);
            // Story 提交成功后进入规则池；Step 5 只记录可选业务缺口，不再生成单卡或等待门禁。
            if (result && result.ok === true) {
                result.nextActionCard = {
                    title: 'stories.json 已落盘（最终版）— 进入 Step 6.6 规则池',
                    stopAfter: false,
                    instruction: 'Story业务补全、Step 6 决策树和 Step 6.5 三问应已在提交前闭合，本次已落盘最终版结构化 Story。旧 ambiguityPoints / ambiguityCards 仅作兼容读取，不要求确认或吸收。下一步只调 req_rule_pool_build_rule_draft，让 Builder 按 stories.json 和已有业务补充召回规则，并进入规则候选/表候选两阶段确认。需求分析.md 不在过程态手写，由 req_finalize_artifacts 收口生成。',
                    afterStep6_6CallTemplate: `req_rule_pool_build_rule_draft(${JSON.stringify({
                        projectPath,
                        skillName: 'epoint-requirement-analyzer'
                    })})`
                };
            }
            return {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
              isError: result.ok !== true
            };
          }

          case "design_tdd_build_plan": {
            // 直接转发 args；ruleService 已经在 designTddPlanService 构造时注入，
            // RelevantRulesBuilder 通过 ruleService.listRules 复用骨架同款规则发现路径
            const result = this.designTddPlanService.buildPlan(args);
            if (result && result.ok === true) {
              this.skillRuntimeToolGuardService.markDesignTddCoderProject(args.projectPath);
            }
            return {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
              isError: result.ok !== true
            };
          }

          case "scan_reuse_index_refresh": {
            // 用户验收后手动触发：把本轮新增/改名的 Service/Action 回灌 code-reuse-index。
            // 不在 finalize 自动跑——finalize 跑通≠用户验收。指路而非缓存：只刷新路径索引。
            const projectPath = String(args.projectPath || '').trim();
            if (!projectPath) {
              return {
                content: [{ type: "text", text: JSON.stringify({ ok: false, status: "blocked", message: "缺少 projectPath 参数" }) }],
                isError: true
              };
            }
            if (!fs.existsSync(projectPath)) {
              return {
                content: [{ type: "text", text: JSON.stringify({ ok: false, status: "blocked", errorCode: "SCAN_REUSE_INDEX_PROJECT_PATH_NOT_FOUND", message: `项目路径不存在：${projectPath}` }) }],
                isError: true
              };
            }
            let refreshResult;
            try {
              refreshResult = this.coderReuseCardService.refreshIndex({
                projectPath,
                scriptPath: this._resolveReuseIndexScriptPath()
              });
            } catch (error) {
              refreshResult = { ok: false, skipped: true, reason: 'reuse_index_refresh_call_failed', message: String(error && error.message || error) };
            }
            const ok = refreshResult && refreshResult.ok === true;
            return {
              content: [{ type: "text", text: JSON.stringify({
                ok,
                status: ok ? 'refreshed' : 'blocked',
                ...(refreshResult && refreshResult.refreshReceipt ? { refreshReceipt: refreshResult.refreshReceipt } : {}),
                ...(refreshResult && refreshResult.reason ? { reason: refreshResult.reason } : {}),
                message: ok
                  ? '复用卡指路索引已刷新：本轮新增/改名的 Service/Action 已可被下一轮 reuseCard 指到。'
                  : '复用卡指路索引刷新未完成；请确认 python 环境与 generate_baseline_report.py 可用。',
                allowedNextActions: ['finish_thread']
              }, null, 2) }],
              isError: false
            };
          }



            default:
              throw new Error(`未知的工具: ${name}`);

          }
          })();
          return response;
        } catch (error) {
          const errorResponse = {
            content: [
              {
                type: "text",
                text: `执行过程中发生错误: ${error.message}`,
              },
            ],
            isError: true,
          };
          return errorResponse;
        }
      }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("[MCP] Epoint Rules MCP Server started.");
  }
}

module.exports = EpointRulesMCPServer;

if (require.main === module) {
  const server = new EpointRulesMCPServer();
  server.run().catch(console.error);
}
