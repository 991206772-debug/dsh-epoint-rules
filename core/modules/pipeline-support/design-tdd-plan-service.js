/* eslint-disable */
const fs = require('fs');
const path = require('path');

const DesignTddContextService = require('./design-tdd-context-service');
const DesignCodingHandoffService = require('./design-coding-handoff-service');
const DesignTddProgressBoardService = require('./design-tdd-progress-board-service');
const RelevantRulesBuilderService = require('./relevant-rules-builder-service');
const RequirementRulePoolService = require('./requirement-rule-pool-service');
const GateContractRegistry = require('./gate-contract-registry');
const DesignTddRuleUsageHintService = require('./design-tdd-rule-usage-hint-service');
const DesignTddDataAccessPlanService = require('./design-tdd-data-access-plan-service');
const DesignTddRouteContractService = require('./design-tdd-route-contract-service');
const DesignTddCodeRuntimeService = require('./design-tdd-code-runtime-service');
const DesignTddSkeletonService = require('./design-tdd-skeleton-service');
const DesignTddTargetProjection = require('./design-tdd-target-projection');
const DesignTddSkeletonDependencyGraphService = require('./design-tdd-skeleton-dependency-graph-service');
const ProjectionTransactionService = require('./design-tdd-projection-transaction-service');
const { readMaterialIndex, obsoleteMaterialFiles } = require('./coder-material-service');
const { ACCEPTANCE_GROUPS, flattenAcceptanceItems } = require('./design-tdd-acceptance-utils');
const resolveSkeletonSectionKey = require('./skeleton-section-key');

const CRUD_SUBTYPE_ORDER = Object.freeze({ list: 1, mylist: 2, add: 3, edit: 4, detail: 5, workflow: 6, workflowdetail: 7 });
const CRUD_SUBTYPES = Object.freeze(['list', 'add', 'edit', 'detail']);
const QUERY_ONLY_TARGET_PAGE_ROLES = Object.freeze(['select', 'report']);
const SERVICE_BUNDLE_KINDS = Object.freeze(['ServiceApi', 'ServiceInternal', 'ServiceImpl']);

function buildMcpToolCall(toolName, args = {}) {
    return {
        mcpServer: 'epoint-project-rules',
        via: 'run_mcp',
        toolName,
        arguments: args,
        instruction: `通过刚刚成功调用 design_tdd_build_plan 的同一个 MCP server 调用 ${toolName}，arguments 原样使用本对象；不要判断工具不可用，不要搜索工具名。`
    };
}

class DesignTddPlanService {
    constructor(options = {}) {
        this.contextService = options.contextService || new DesignTddContextService();
        this.codingHandoffService = options.codingHandoffService || new DesignCodingHandoffService();
        this.progressBoardService = options.progressBoardService || new DesignTddProgressBoardService();
        // ruleService 从 mcp 入口注入，给 RelevantRulesBuilder 用（复用骨架同款规则发现路径）
        this.ruleService = options.ruleService || null;
        this.relevantRulesBuilderService = options.relevantRulesBuilderService
            || new RelevantRulesBuilderService({ ruleService: this.ruleService });
        this.ruleUsageHintService = options.ruleUsageHintService || new DesignTddRuleUsageHintService();
        this.dataAccessPlanService = options.dataAccessPlanService || new DesignTddDataAccessPlanService();
        this.routeContractService = options.routeContractService || new DesignTddRouteContractService();
        this.codeRuntimeService = options.codeRuntimeService || new DesignTddCodeRuntimeService();
        this.workProjectionService = options.workProjectionService || new DesignTddSkeletonService({
            ruleService: this.ruleService
        });
        this.targetProjection = options.targetProjection || new DesignTddTargetProjection();
        this.skeletonDependencyGraphService = options.skeletonDependencyGraphService
            || new DesignTddSkeletonDependencyGraphService();
        this.transactionService = options.transactionService || new ProjectionTransactionService();
    }

    buildPlan(args = {}) {
        try { return this._buildPlan(args); }
        catch (error) { return this._writeFailure(error); }
    }

    buildPlanWithDesign(args = {}, designDocument = {}) {
        if (!designDocument || typeof designDocument !== 'object' || Array.isArray(designDocument)) {
            return this._blocked('DESIGN_TDD_PLAN_PREFLIGHT_DESIGN_INVALID', '内部Coder预检缺少有效Design机器合同。');
        }
        return this._buildPlan(args, designDocument);
    }

    _designInputHash(value = {}) {
        return require('crypto').createHash('sha256').update(JSON.stringify(value || {}), 'utf8').digest('hex');
    }

    _readJson(target = '') {
        try {
            return target && fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : null;
        } catch (_) {
            return null;
        }
    }

    _hasCurrentCoderMaterial(codeDir = '') {
        const root = path.resolve(String(codeDir || '').trim());
        const index = this._readJson(path.join(root, 'requirement-work-draft.json'));
        if (!index || index.schemaVersion !== 'requirement-work-draft-index/v3') return false;
        if (readMaterialIndex(root)?.schemaVersion !== 'work-slices-index/v3') return false;
        return [index.storyCatalogRef, index.targetIndexRef, index.readCatalogRef]
            .every(ref => {
                const value = String(ref || '').trim();
                return value && fs.existsSync(path.isAbsolute(value) ? value : path.join(root, value));
            });
    }

    _buildPlan(args = {}, designDocumentOverride = null) {
        const hasDesignOverride = designDocumentOverride
            && typeof designDocumentOverride === 'object'
            && typeof this.contextService.prepareForBuilderWithDesign === 'function';
        const context = hasDesignOverride
            ? this.contextService.prepareForBuilderWithDesign(args, designDocumentOverride)
            : (typeof this.contextService.prepareForBuilder === 'function'
                ? this.contextService.prepareForBuilder(args)
                : this.contextService.prepare(args));
        if (context.ok !== true) {
            return {
                ...context,
                source: 'design_tdd_build_plan'
            };
        }

        const designDocument = context.loadedArtifacts.designDocument || {};
        const canonicalCodeDir = path.dirname(context.fixedPaths.designTddPlanPath);
        const pendingTransactions = args.writeToFile === false ? { ok: true } : this.transactionService.recoverPending({
            managedRoots: [canonicalCodeDir],
            transactionRoot: path.join(canonicalCodeDir, '.projection-tx')
        });
        if (!pendingTransactions.ok) {
            return {
                ...pendingTransactions,
                source: 'design_tdd_build_plan'
            };
        }
        if (args.writeToFile !== false) this.transactionService.cleanOrphanedStaging({
            rootDir: canonicalCodeDir, transactionRoot: path.join(canonicalCodeDir, '.projection-tx') });
        const previousPlan = this._readJson(path.join(canonicalCodeDir, 'design-tdd-plan.json'));
        const previousState = this._readJson(path.join(canonicalCodeDir, 'code-state.json'));
        const sameDesign = previousPlan?.designInputHash === this._designInputHash(designDocument);
        if (args.writeToFile !== false && args.overwritePlan !== true && sameDesign
            && fs.existsSync(path.join(canonicalCodeDir, 'business-facts.json'))) {
            if (!this._hasCurrentCoderMaterial(canonicalCodeDir)) {
                try {
                    const projection = this.workProjectionService.rebuildWorkProjection({
                        projectPath: args.projectPath, plan: previousPlan,
                        facts: this._readJson(path.join(canonicalCodeDir, 'business-facts.json')) });
                    if (!projection.ok) return projection;
                } catch (error) { return this._writeFailure(error); }
            }
            const batch = this.codeRuntimeService.getSkeletonWork({ projectPath: args.projectPath });
            const runtime = batch.ok
                ? (batch.status === 'skeleton_completed_replay'
                    ? this.codeRuntimeService.replaySkeletonCompletion({ batch })
                    : { ok: true, nextActionCard: { toolName: 'design_tdd_skeleton_materialize',
                        arguments: { projectPath: args.projectPath } } })
                : this.codeRuntimeService.prepare({ projectPath: args.projectPath });
            if (!runtime.ok) return runtime;
            return { ok: true, status: 'ready', idempotentReplay: true,
                summary: previousPlan.summary, fixedPaths: {
                    designTddPlanPath: context.fixedPaths.designTddPlanPath, codeStatePath: context.fixedPaths.codeStatePath },
                nextActionCard: runtime.nextActionCard || { codingMode: 'vibe_coding', stopAfter: false,
                    instruction: '继续现有计划与未完成任务，不重建骨架。' } };
        }
        const navigationContract = context.loadedArtifacts.navigationContract || {};
        const placementContracts = context.loadedArtifacts.placementContracts || {};
        const frameworkBucket = context.loadedArtifacts.frameworkBucket || {};
        if (this.dataAccessPlanService
            && typeof this.dataAccessPlanService.resetReuseIndexPreparation === 'function') {
            // 一个 design_tdd_build_plan 调用对应一次轻量 --reuse-index 刷新；
            // 不复用上一次调用的索引状态，避免同一 MCP 进程里继续读过期索引。
            this.dataAccessPlanService.resetReuseIndexPreparation();
        }
        const htmlContract = placementContracts.HtmlPage || this._extractPlacementContract(navigationContract, 'HtmlPage');
        const modules = Array.isArray(designDocument.modules) ? designDocument.modules : [];
        const unresolvedRuleSignals = this._requirementUnresolvedSignals(context.loadedArtifacts.requirementRulePool);

        const handoffCheck = this._validateCodingHandoff(modules, htmlContract, designDocument, navigationContract);
        if (!handoffCheck.ok) {
            return this._blocked('DESIGN_TDD_PLAN_CODING_HANDOFF_MISSING',
                '设计文档缺少编码阶段可回放的 codingHandoff，禁止由编码阶段猜 bizModule/pagename/文件/方法。',
                {
                    source: 'design_tdd_build_plan',
                    fixedPaths: context.fixedPaths,
                    missingModules: handoffCheck.missingModules,
                    repairHint: '回到 epoint-requirement-design 修 设计文档.json：按 repairCards[].repairTemplate 补齐 LLM-owned 编码交接字段。',
                    repairCards: handoffCheck.repairCards
                });
        }

        const build = this._buildStructuredPlan({
            context,
            modules,
            htmlContract,
            placementContracts,
            frameworkBucket,
            projectPath: String(args.projectPath || '').trim()
        });
        if (!build.ok) {
            return build;
        }
        const compositionChildQueryProjection = this._buildCompositionChildQueryContracts({
            designDocument,
            modulePlans: build.modulePlans,
            filePlan: build.filePlan
        });
        if (!compositionChildQueryProjection.ok) {
            return compositionChildQueryProjection;
        }
        const requirementWorkPackageSeed = this._buildRequirementWorkPackageSeed(designDocument);
        const existingUpdateTargets = this._buildExistingUpdateTargets(
            requirementWorkPackageSeed.userStories,
            String(args.projectPath || '').trim()
        );
        const constructionBindings = this._collectConstructionBindings(modules);
        let businessFactsPath = path.join(canonicalCodeDir, 'business-facts.json');
        const dataAccessPlans = this.dataAccessPlanService.buildPlans({
            projectPath: String(args.projectPath || '').trim(),
            designDocument,
            modulePlans: build.modulePlans,
            filePlan: build.filePlan,
            constructionBindings
        });
        const blockedDataAccessPlan = Object.values(dataAccessPlans.plansByModuleId || {})
            .find(plan => plan && plan.mode === 'blocked');
        if (blockedDataAccessPlan) {
            return this._blocked(
                blockedDataAccessPlan.errorCode || 'DESIGN_TDD_REUSE_QUERY_ACCESS_PLAN_MISSING',
                blockedDataAccessPlan.message || '复用表 query-only 列表缺少已确认查询访问方式。',
                {
                    source: 'design_tdd_build_plan',
                    moduleId: blockedDataAccessPlan.moduleId,
                    dataAccessPlan: blockedDataAccessPlan,
                    defectOwner: blockedDataAccessPlan.defectOwner || 'Builder',
                    allowedNextActions: blockedDataAccessPlan.allowedNextActions || [
                        'rerun_project_scan_to_refresh_code_reuse_index',
                        'repair_coder_projection_after_query_access_evidence_ready'
                    ]
                }
            );
        }

        const markdown = this._renderMarkdown({
            context,
            modulePlans: build.modulePlans,
            intentLocks: build.intentLocks,
            filePlan: build.filePlan,
            htmlPages: build.htmlPages,
            existingUpdateTargets,
            serviceContractSeeds: build.serviceContractSeeds,
            actionContractSeeds: build.actionContractSeeds,
            frameworkBucket
        });

        const writeToFile = args.writeToFile !== false;
        const routeContracts = this.routeContractService.buildContracts({
            projectPath: String(args.projectPath || '').trim(),
            candidateFiles: this._buildPreMaterializeCandidateFiles(build.filePlan, existingUpdateTargets)
        });
        const projection = this.targetProjection.project({
            projectPath: String(args.projectPath || '').trim(),
            filePlan: build.filePlan,
            modulePlans: build.modulePlans,
            dataAccessPlans: dataAccessPlans.plansByModuleId,
            intents: []
        });
        if (!projection.ok) return projection;
        const modulesOwnerFiles = projection.modulesOwnerFiles;
        const storyWorkPackages = projection.storyWorkPackages;
        const fileProjectionIntegrity = projection.fileProjectionIntegrity;
        const skeletonDependencyGraph = this.skeletonDependencyGraphService.build({
            projectPath: String(args.projectPath || '').trim(),
            modulesOwnerFiles,
            modulePlans: build.modulePlans,
            dataAccessPlans: dataAccessPlans.plansByModuleId,
            serviceContractSeeds: build.serviceContractSeeds
        });
        if (!skeletonDependencyGraph.ok) return skeletonDependencyGraph;
        let stagingDir = '';
        try {
            if (writeToFile) {
                const transactionRoot = path.join(canonicalCodeDir, '.projection-tx');
                fs.mkdirSync(transactionRoot, { recursive: true });
                stagingDir = fs.mkdtempSync(path.join(transactionRoot, `plan-${process.pid}-`));
                const artifactSnapshot = path.join(canonicalCodeDir, 'work-slices/generated-artifacts.json');
                if (fs.existsSync(artifactSnapshot)) {
                    const stagedSnapshot = path.join(stagingDir, 'work-slices/generated-artifacts.json');
                    fs.mkdirSync(path.dirname(stagedSnapshot), { recursive: true });
                    fs.copyFileSync(artifactSnapshot, stagedSnapshot);
                }
                context.fixedPaths = { ...context.fixedPaths,
                    designTddPlanPath: path.join(stagingDir, 'design-tdd-plan.md') };
                businessFactsPath = path.join(stagingDir, 'business-facts.json');
            }
            let planJsonForRuntime = null;
            if (writeToFile) {
                const planPath = context.fixedPaths.designTddPlanPath;
                fs.mkdirSync(path.dirname(planPath), { recursive: true });
                fs.writeFileSync(planPath, markdown, 'utf-8');

                // 同步落盘 design-tdd-plan.json（机器合同）：filePlan 列表 + 每模块 owner 顺序，
                // 给 design_tdd_skeleton_materialize 物化时反查"本模块还差哪个 fileKind"用。
                // markdown 是人读，JSON 是机器读；两者一致由 Builder 同次写入保证。
                const planJsonPath = planPath.replace(/\.md$/i, '.json');
                const planJson = {
                    schemaVersion: 'design-tdd-plan/v1',
                    generatedAt: new Date().toISOString(),
                    designInputHash: this._designInputHash(designDocument),
                    summary: {
                        moduleCount: build.modulePlans.length,
                        fileCount: build.filePlan.length,
                        htmlPageCount: build.htmlPages.length,
                        existingUpdateTargetCount: existingUpdateTargets.length,
                        existingUpdateStoryCount: new Set(existingUpdateTargets.map(item => item.storyId).filter(Boolean)).size,
                        unresolvedSignalCount: unresolvedRuleSignals.length
                    },
                    requirementWorkPackage: requirementWorkPackageSeed,
                    existingUpdateTargets,
                    constructionBindings,
                    routeContracts,
                    // 统一投影的机械输入保留在机器合同中。Markdown 不参与下游重建；
                    // 动态目标请求只重算这份 fileSet，而不让 LLM 重填路径或模块结构。
                    modulePlans: build.modulePlans,
                    filePlan: build.filePlan,
                    placementContracts,
                    // owner 文件按模块分组（排好顺序），每个 entry 列出本模块所有 owner-role 文件
                    modulesOwnerFiles,
                    storyWorkPackages,
                    fileProjectionIntegrity,
                    skeletonDependencyGraph,
                    projectionHashes: projection.projectionHashes,
                    dataAccessPlans,
                    // 骨架组合合同：给后续 Coder 调度消费的 Builder-owned 组合视图。
                    // 不替换 modulesOwnerFiles；当前物化仍然一文件一次，组合只表达职责颗粒度。
                    skeletonComposition: this._buildSkeletonComposition(modulesOwnerFiles),
                    // intentLocks 摘要：moduleId/businessContext/sectionKey 选用，让物化时不再读 markdown
                    intentLocks: build.intentLocks.map(lock => ({
                        moduleId: lock.moduleId,
                        businessContext: lock.businessContext || {},
                        allowedFiles: lock.allowedFiles || []
                    }))
                };
                planJsonForRuntime = planJson;
                try {
                    fs.writeFileSync(planJsonPath, JSON.stringify(planJson, null, 2), 'utf-8');
                } catch (error) {
                    return this._writeFailure(error);
                }

                // 注意：business-facts.json 落盘要在 relevant-rules.json 之后（依赖其内容渲染 selfAudit），
                // 移到下面 _buildAndWriteRelevantRules 后面统一处理。
            }

            // 落盘相关规则清单（relevant-rules.json）：
            // 故事线：LLM 凭印象写 userSession.getUserName() 是因为没人推送 UserSession 规范。
            // 修法：build_plan 时一次性把本需求所有相关规则的 filePath / intentKeywords / description
            // 落盘到 <demandDir>/code/relevant-rules.json；business-facts.json 再从这些规则提炼
            // apiUsageHints。Story 需求施工包只展示当前最相关的小抄，完整规则仍通过 ruleRefs 按需读原文。
            // 失败不阻断 buildPlan（规则清单只是辅助，缺它仍能跑 TDD，但会让 LLM 回到凭印象写）。
            let relevantRulesWrite = null;
            let relevantRulesPayload = null;
            if (writeToFile) {
                const rrResult = this._buildAndWriteRelevantRules({
                    context,
                    designDocument,
                    modulePlans: build.modulePlans,
                    projectPath: String(args.projectPath || '').trim()
                });
                relevantRulesWrite = rrResult;
                // 把 builder 内部计算出来的 payload 透出来给下面的 business-facts 复用，
                // 不再二次读盘 relevant-rules.json。
                relevantRulesPayload = rrResult && rrResult._inMemoryPayload ? rrResult._inMemoryPayload : null;
                if (rrResult && rrResult.ok !== true) {
                    return rrResult;
                }
            }

            // 同步落盘 business-facts.json（业务事实索引）：每模块的 databaseTables /
            // acceptanceCriteria / confirmedRules / selfAuditBeforeWrite / apiUsageHints 落到独立文件，
            // 让物化主返回不再重复携带这些大对象（每次物化省 ~7k 字符）。
            // 故事线：MOD-01 的 6 次物化（Entity/ServiceApi/ServiceInternal/ServiceImpl/Action/HtmlPage）
            // 业务事实是同一份，老方案每次都喂一遍 → 7 步累计 60k+ 字符灌进 LLM 上下文。
            // 修法：build_plan 一次性把所有模块业务事实落盘，物化主返回只给 businessFactsRef
            // 指针 + readWhen 触发条件，LLM 自觉按需 read_file。
            // 机器事实保留供资料投影与骨架恢复使用，不进入 Coder 启动必读清单。
            if (writeToFile) {
                const frameworkContext = this._extractFrameworkContext(context.loadedArtifacts.frameworkBucket || {});
                const businessFactsJson = this._buildBusinessFactsJson({
                    designDocument,
                    requirementRulePool: context.loadedArtifacts.requirementRulePool,
                    modulePlans: build.modulePlans,
                    relevantRulesData: relevantRulesPayload,
                    dataAccessPlans: dataAccessPlans.plansByModuleId,
                    serviceContractSeeds: build.serviceContractSeeds,
                    actionContractSeeds: build.actionContractSeeds,
                    compositionChildQueries: compositionChildQueryProjection.contracts,
                    compositionFormBindings: compositionChildQueryProjection.formBindings,
                    routeContracts,
                    versionBucket: frameworkContext.versionBucket,
                    frameworkVersion: frameworkContext.frameworkVersion
                });
                try {
                    fs.writeFileSync(businessFactsPath, JSON.stringify(businessFactsJson, null, 2), 'utf-8');
                    this.codeRuntimeService.initialize({
                        codeDir: path.dirname(context.fixedPaths.designTddPlanPath),
                        demandName: context.demandName,
                        facts: businessFactsJson,
                        plan: planJsonForRuntime || {}, previousPlan, previousState
                    });
                } catch (error) {
                    return this._writeFailure(error);
                }
                const workProjection = this.workProjectionService.rebuildWorkProjection({
                    projectPath: String(args.projectPath || '').trim(),
                    facts: businessFactsJson,
                    plan: planJsonForRuntime || {}, outputCodeDir: stagingDir
                });
                if (!workProjection || workProjection.ok !== true) {
                    return {
                        ...(workProjection || {}),
                        ok: false,
                        status: 'blocked',
                        source: 'design_tdd_build_plan',
                        errorCode: workProjection && workProjection.errorCode || 'DESIGN_TDD_WORK_PROJECTION_BUILD_FAILED',
                        message: workProjection && workProjection.message || 'Coder施工投影生成失败。'
                    };
                }
            }

            // s2c 范式：返回里直接给 LLM "下一步只要这样调即可" 的 callTemplate，
            // 让 LLM 不需要思考、不需要搜索、不需要读 plan.md 才能进入下一动作。
            // 故事线：截图里 LLM 跳 Step 0 直接物化 + 漏 ServiceInternal + workspace search references
            // 都是因为它没有强制的"下一步动作卡"，看完返回得自己想下一步——失忆窗口里思维就跑偏。
            // 修法：build_plan 完成后直接把"等用户确认 → 然后调第一个 owner 文件 materialize"
            // 的 callTemplate 写好，LLM 复制粘贴即可。
            if (writeToFile) {
                const published = this._publishStagedPlan(stagingDir, canonicalCodeDir, previousPlan, planJsonForRuntime);
                if (!published.ok) return published;
                context.fixedPaths.designTddPlanPath = path.join(canonicalCodeDir, 'design-tdd-plan.md');
                if (relevantRulesWrite?.path) relevantRulesWrite.path = path.join(canonicalCodeDir, 'relevant-rules.json');
            }
            const runtimeState = writeToFile
                ? this.codeRuntimeService.prepare({ projectPath: String(args.projectPath || '').trim() }) : null;
            if (writeToFile && !runtimeState?.ok) return runtimeState || this._writeFailure(new Error('编码运行态恢复失败'));

            return {
                ok: true,
                status: 'ready',
                // AGENTS.md "返回瘦身"：删 source/overwritePlan/actionMode 入参回显，
                // 删 allowedNextActions/forbiddenNextActions/nextStep 文字（与 nextActionCard 重复）。
                // fixedPaths 只留 LLM 后续真正需要的计划和运行态路径；scan 类路径由 Builder 内部使用。
                fixedPaths: {
                    designTddPlanPath: context.fixedPaths.designTddPlanPath,
                    codeStatePath: context.fixedPaths.codeStatePath
                },
                plan: {
                    written: writeToFile,
                    path: context.fixedPaths.designTddPlanPath
                },
                ...(relevantRulesWrite && relevantRulesWrite.ok === true
                    ? { relevantRules: { written: true, path: relevantRulesWrite.path || '' } }
                    : {}),
                summary: {
                    moduleCount: build.modulePlans.length,
                    fileCount: build.filePlan.length,
                    htmlPageCount: build.htmlPages.length,
                    existingUpdateTargetCount: existingUpdateTargets.length,
                    existingUpdateStoryCount: new Set(existingUpdateTargets.map(item => item.storyId).filter(Boolean)).size,
                    unresolvedSignalCount: unresolvedRuleSignals.length,
                    unresolvedSignalsAdvisoryOnly: true
                },
                // s2c 风格"下一步即拉即给"动作卡：plan 落盘后直接进入逐模块物化（连跑），
                // 不再弹用户确认卡——用户在设计阶段已确认 modules/databaseDecisions，
                // 编码阶段是机械执行 plan，确认价值低于打断价值。
                // displayLine：调下一个工具前先输出给用户看，让 trace 不再黑盒。
                nextActionCard: runtimeState && runtimeState.phase === 'skeleton_materialize'
                    ? {
                        title: 'Plan 已落盘，批量物化全部机械骨架',
                        stopAfter: false,
                        displayLine: `Plan 已落盘：${build.modulePlans.length} 模块 / ${build.filePlan.length} 文件 / ${build.htmlPages.length} 页面，开始一次批量物化。`,
                        displayRequired: true,
                        instruction: '调用一次 design_tdd_skeleton_materialize；Builder 从 plan 取得全部目标，不要填写 targetFile/fileKind/moduleId。',
                        toolCall: buildMcpToolCall('design_tdd_skeleton_materialize', runtimeState.nextActionCard.arguments),
                        callTemplate: `design_tdd_skeleton_materialize(${JSON.stringify(runtimeState.nextActionCard.arguments)})`,
                        afterThisCallSeeNextActionCard: true
                    }
                    : runtimeState && runtimeState.codingMode === 'vibe_coding'
                        ? {
                            title: 'Plan 已落盘，进入整需求 Vibe Coding',
                            stopAfter: true,
                            codingMode: 'vibe_coding',
                            instruction: '骨架完成后由 epoint-design-tdd-coder 主 Skill 先读 intake 和全部功能目录，当前 Story 完整要求按需读取；任务要求和实际进展统一落盘 demand-implementation-tasks.md，按主 Skill 展示 TodoList 并连续实现和验证，不调用状态推进类 MCP。'
                        }
                    : runtimeState && runtimeState.executionBundleRef
                        ? {
                            title: 'Plan 已落盘，等待骨架完成后进入整需求业务实现',
                            stopAfter: false,
                            instruction: '继续调用 design_tdd_skeleton_materialize 完成批量骨架；骨架完成后不按单个 Story 或文件推进。'
                        }
                        : null
            };
        } finally {
            if (stagingDir && !fs.existsSync(path.join(stagingDir, 'projection-transaction.json'))) {
                this.transactionService.discardStaging({ stagingDir, managedRoots: [canonicalCodeDir] });
            }
        }
    }

    _writeFailure(error) {
        return { ok: false, status: 'repair_required', errorCode: 'DESIGN_TDD_PLAN_WRITE_INTERRUPTED',
            message: `施工资料未更新，旧有效资料保持不变：${error.message}`,
            stopAfter: false, machineRecoverable: true, stopLockRequired: false,
            allowedNextActions: ['rerun_design_tdd_build_plan'],
            nextActionCard: { toolName: 'design_tdd_build_plan' } };
    }

    _publishStagedPlan(stagingDir, codeDir, previousPlan, nextPlan) {
        const files = [];
        const collect = dir => fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
            const source = path.join(dir, entry.name);
            if (entry.isSymbolicLink() || entry.name === '.projection-tx' || entry.name === 'before') return;
            if (entry.isDirectory()) collect(source);
            else {
                let content = fs.readFileSync(source, 'utf8');
                for (const [from, to] of [[stagingDir, codeDir],
                    [JSON.stringify(stagingDir).slice(1, -1), JSON.stringify(codeDir).slice(1, -1)],
                    [stagingDir.replace(/\\/g, '/'), codeDir.replace(/\\/g, '/')]]) content = content.split(from).join(to);
                fs.writeFileSync(source, content, 'utf8');
                files.push({ path: path.join(codeDir, path.relative(stagingDir, source)), newPath: source });
            }
        });
        try {
            collect(stagingDir);
            files.push(...obsoleteMaterialFiles(codeDir, files.map(file => path.relative(codeDir, file.path))));
            return this.transactionService.publishFiles({ rootDir: codeDir, stagingDir, files,
                oldRevision: previousPlan?.designInputHash, newRevision: nextPlan?.designInputHash });
        } catch (error) { return this._writeFailure(error); }
        finally {
            if (!fs.existsSync(path.join(stagingDir, 'projection-transaction.json'))) {
                this.transactionService.discardStaging({ stagingDir, managedRoots: [codeDir] });
            }
        }
    }

    /**
     * 把 dedup 后的 filePlan 按 owner 模块分组，给 design_tdd_skeleton_materialize 反查
     * "本模块还差哪个 fileKind 没物化"用。
     *
     * 排序约定（owner 物化顺序）：
     *   Entity → ServiceApi → ServiceInternal → ServiceImpl → Action → HtmlPage
     * Builder 把这个排序固化下来，LLM 物化时按这个顺序走，不需要自己想"先做哪个"。
     */
    _buildRequirementWorkPackageSeed(designDocument = {}) {
        return {
            driver: 'userStory',
            userStories: Object.values(this._buildStoriesIndexFromDesignDocument(designDocument))
        };
    }

    _buildExistingUpdateTargets(userStories = [], projectPath = '') {
        const out = [];
        const seen = new Set();
        const projectRoot = String(projectPath || '').trim();
        for (const story of (Array.isArray(userStories) ? userStories : [])) {
            const storyId = String(story && story.storyId || '').trim().toUpperCase();
            const entryFiles = story && story.existingAdjustment && Array.isArray(story.existingAdjustment.entryFiles)
                ? story.existingAdjustment.entryFiles
                : [];
            for (const entry of entryFiles) {
                const fileKind = String(entry && entry.fileKind || '').trim();
                const rawPath = String(entry && (entry.resolvedPath || entry.path || entry.filePath) || '').trim();
                if (!storyId || !fileKind || !rawPath) continue;
                const resolvedPath = path.isAbsolute(rawPath)
                    ? path.resolve(rawPath)
                    : (projectRoot ? path.resolve(projectRoot, rawPath) : rawPath);
                const key = `${storyId}::${fileKind}::${resolvedPath}`;
                if (seen.has(key)) continue;
                seen.add(key);
                out.push({
                    storyId,
                    fileKind,
                    resolvedPath,
                    operation: 'modify',
                    source: String(entry && entry.source || 'stories.existingAdjustment.entryFiles').trim() || 'stories.existingAdjustment.entryFiles',
                    verificationStatus: String(entry && entry.verificationStatus || 'pending').trim() || 'pending'
                });
            }
        }
        return out;
    }

    _collectConstructionBindings(modules = []) {
        const out = [];
        const seen = new Set();
        for (const mod of (Array.isArray(modules) ? modules : [])) {
            const moduleId = String(mod && mod.moduleId || '').trim();
            const handoff = mod && mod.codingHandoff && typeof mod.codingHandoff === 'object'
                ? mod.codingHandoff
                : {};
            const bindings = Array.isArray(handoff.constructionBindings)
                ? handoff.constructionBindings
                : (Array.isArray(mod && mod.constructionBindings) ? mod.constructionBindings : []);
            for (const binding of bindings) {
                const storyId = String(binding && binding.storyId || '').trim().toUpperCase();
                const routeKey = String(binding && binding.routeKey || '').trim();
                const key = `${moduleId}::${storyId}::${routeKey}`;
                if (!moduleId || !storyId || seen.has(key)) continue;
                seen.add(key);
                out.push({ moduleId, ...JSON.parse(JSON.stringify(binding)) });
            }
        }
        return out;
    }

    _buildPreMaterializeCandidateFiles(filePlan = [], existingUpdateTargets = []) {
        const out = [];
        const seen = new Set();
        const pushFile = (file = {}) => {
            const fileKind = String(file && file.fileKind || '').trim();
            const resolvedPath = String(file && (file.resolvedPath || file.path || file.filePath) || '').trim();
            if (!fileKind || !resolvedPath) return;
            const key = `${fileKind}::${resolvedPath}`;
            if (seen.has(key)) return;
            seen.add(key);
            out.push({
                fileKind,
                resolvedPath,
                ...(file.businessObject ? { businessObject: String(file.businessObject).trim() } : {})
            });
        };
        (Array.isArray(filePlan) ? filePlan : []).forEach(pushFile);
        (Array.isArray(existingUpdateTargets) ? existingUpdateTargets : []).forEach(pushFile);
        return out;
    }




    _buildStoriesIndexFromDesignDocument(designDocument = {}) {
        const out = {};
        const pushStory = (story = {}) => {
            const storyId = String(story.storyId || story.id || '').trim().toUpperCase();
            const userStory = String(story.userStory || story.description || '').trim();
            if (!storyId || !userStory || out[storyId]) return;
            out[storyId] = {
                storyId,
                userStory,
                ...(story.actor ? { actor: String(story.actor).trim() } : {}),
                ...(story.deliveryBoundary ? { deliveryBoundary: String(story.deliveryBoundary).trim() } : {}),
                invariants: Array.isArray(story.invariants)
                    ? story.invariants.map(item => String(item || '').trim()).filter(Boolean)
                    : [],
                acceptanceCriteria: this._normalizeStoryAcceptanceCriteria(story.acceptanceCriteria),
                ...this._codingFactHandoffProjection(story),
                ...this._existingAdjustmentProjection(story)
            };
        };
        if (Array.isArray(designDocument.stories)) {
            designDocument.stories.forEach(pushStory);
        }
        if (Array.isArray(designDocument.businessEntities)) {
            for (const entity of designDocument.businessEntities) {
                if (Array.isArray(entity && entity.relatedStories)) {
                    entity.relatedStories.forEach(pushStory);
                }
            }
        }
        for (const mod of (Array.isArray(designDocument.modules) ? designDocument.modules : [])) {
            if (Array.isArray(mod && mod.relatedStories)) {
                mod.relatedStories.forEach(pushStory);
            }
            const storyId = String(mod && mod.storyId || '').trim().toUpperCase();
            const userStory = String(mod && mod.userStory || mod && mod.description || '').trim();
            if (storyId && userStory) pushStory({ storyId, userStory, invariants: mod.invariants || [] });
        }
        return out;
    }

    _existingAdjustmentProjection(story = {}) {
        const existing = story && story.existingAdjustment && typeof story.existingAdjustment === 'object' && !Array.isArray(story.existingAdjustment)
            ? story.existingAdjustment
            : {};
        const entryFiles = this._normalizeExistingAdjustmentEntryFiles(existing.entryFiles);
        const preserveBehaviors = this._normalizeExistingAdjustmentPreserveBehaviors(existing.preserveBehaviors);
        const existingAdjustment = {};
        if (entryFiles.length > 0) existingAdjustment.entryFiles = entryFiles;
        if (preserveBehaviors.length > 0) existingAdjustment.preserveBehaviors = preserveBehaviors;
        return Object.keys(existingAdjustment).length > 0 ? { existingAdjustment } : {};
    }

    _normalizeExistingAdjustmentEntryFiles(entryFiles = []) {
        const allowed = new Set(['HtmlPage', 'Action']);
        const out = [];
        const seen = new Set();
        for (const entry of (Array.isArray(entryFiles) ? entryFiles : [])) {
            const fileKind = String(entry && entry.fileKind || '').trim();
            const entryPath = String(entry && (entry.path || entry.resolvedPath || entry.filePath) || '').trim();
            if (!allowed.has(fileKind) || !entryPath) continue;
            const key = `${fileKind}::${entryPath}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({
                fileKind,
                path: entryPath,
                source: String(entry && entry.source || 'stories.existingAdjustment.entryFiles').trim() || 'stories.existingAdjustment.entryFiles',
                verificationStatus: String(entry && entry.verificationStatus || 'pending').trim() || 'pending'
            });
        }
        return out;
    }

    _normalizeStoryAcceptanceCriteria(ac = {}) {
        const result = { happyPath: [], exception: [], boundary: [] };
        if (!ac || typeof ac !== 'object' || Array.isArray(ac)) return result;
        ACCEPTANCE_GROUPS.forEach(group => {
            const arr = Array.isArray(ac[group]) ? ac[group] : [];
            result[group] = arr.map((item, index) => {
                if (typeof item === 'string') {
                    return {
                        scenario: `${group}-${index + 1}`,
                        given: item,
                        when: '',
                        then: ''
                    };
                }
                return {
                    scenario: String(item && item.scenario || `${group}-${index + 1}`).trim(),
                    given: String(item && item.given || '').trim(),
                    when: String(item && item.when || '').trim(),
                    then: String(item && item.then || '').trim(),
                    ...(item && item.code ? { code: String(item.code || '').trim() } : {})
                };
            });
        });
        return result;
    }

    _normalizeExistingAdjustmentPreserveBehaviors(preserveBehaviors = []) {
        const out = [];
        const seen = new Set();
        for (const item of (Array.isArray(preserveBehaviors) ? preserveBehaviors : [])) {
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

    _codingFactHandoffProjection(story = {}) {
        const raw = Array.isArray(story && story.codingFactHandoff) ? story.codingFactHandoff : [];
        const out = [];
        const seen = new Set();
        raw.forEach(item => {
            const normalized = this._normalizeCodingFactHandoffItem(item);
            if (!normalized) return;
            const key = `${normalized.factId || ''}::${normalized.description || ''}::${JSON.stringify(normalized.source || {})}`;
            if (seen.has(key)) return;
            seen.add(key);
            out.push(normalized);
        });
        return out.length > 0 ? { codingFactHandoff: out } : {};
    }

    _normalizeCodingFactHandoffItem(item = {}) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
        const out = {};
        ['factId', 'factType', 'description'].forEach(key => {
            const value = String(item && item[key] || '').trim();
            if (value) out[key] = value;
        });
        ['confirmedFacts'].forEach(key => {
            const values = Array.isArray(item && item[key])
                ? item[key].map(value => String(value || '').trim()).filter(Boolean)
                : [];
            if (values.length > 0) out[key] = Array.from(new Set(values));
        });
        return Object.keys(out).length > 0 ? out : null;
    }

    _collectCodingFactHandoff(stories = {}) {
        const out = [];
        const seen = new Set();
        Object.values(stories || {}).forEach(story => {
            const storyId = String(story && story.storyId || '').trim().toUpperCase();
            const items = Array.isArray(story && story.codingFactHandoff) ? story.codingFactHandoff : [];
            for (const item of items) {
                const normalized = this._normalizeCodingFactHandoffItem(item);
                if (!normalized) continue;
                const key = `${storyId}::${normalized.factId || ''}::${normalized.description || ''}`;
                if (seen.has(key)) continue;
                seen.add(key);
                out.push({
                    storyId,
                    ...normalized
                });
            }
        });
        return out;
    }

    _collectHistoricalEntryFiles(stories = {}) {
        const out = [];
        const seen = new Set();
        Object.values(stories || {}).forEach(story => {
            const storyId = String(story && story.storyId || '').trim().toUpperCase();
            const entryFiles = story && story.existingAdjustment && Array.isArray(story.existingAdjustment.entryFiles)
                ? story.existingAdjustment.entryFiles
                : [];
            for (const entry of entryFiles) {
                const fileKind = String(entry && entry.fileKind || '').trim();
                const resolvedPath = String(entry && (entry.resolvedPath || entry.path || entry.filePath) || '').trim();
                if (!storyId || !fileKind || !resolvedPath) continue;
                const key = `${storyId}::${fileKind}::${resolvedPath}`;
                if (seen.has(key)) continue;
                seen.add(key);
                out.push({
                    storyId,
                    fileKind,
                    resolvedPath,
                    operation: 'modify',
                    source: String(entry && entry.source || 'stories.existingAdjustment.entryFiles').trim() || 'stories.existingAdjustment.entryFiles',
                    verificationStatus: String(entry && entry.verificationStatus || 'pending').trim() || 'pending'
                });
            }
        });
        return out;
    }

    _collectHistoricalBehaviorFacts(stories = {}) {
        const out = [];
        const seen = new Set();
        Object.values(stories || {}).forEach(story => {
            const storyId = String(story && story.storyId || '').trim().toUpperCase();
            const preserveBehaviors = story && story.existingAdjustment && Array.isArray(story.existingAdjustment.preserveBehaviors)
                ? story.existingAdjustment.preserveBehaviors
                : [];
            for (const item of preserveBehaviors) {
                const businessResult = String(item && item.businessResult || '').trim();
                const regressionScope = String(item && item.regressionScope || '').trim();
                if (!storyId || !businessResult) continue;
                const key = `${storyId}::${businessResult}::${regressionScope}`;
                if (seen.has(key)) continue;
                seen.add(key);
                out.push({
                    storyId,
                    businessResult,
                    ...(regressionScope ? { regressionScope } : {}),
                    source: 'stories.existingAdjustment.preserveBehaviors'
                });
            }
        });
        return out;
    }

    /**
     * 构建 business-facts.json 内容：需求级 Stories、不可变 AC 定义、业务事实和规则池。
     *
     * 新形态不再写顶层 modules：LLM 主线只看到本次需求整体的 stories / candidate facts /
     * rulePool；编码进度由整需求实施计划记录，Builder 不创建逐 Story 编码状态。
     */
    _buildBusinessFactsJson({ designDocument, requirementRulePool = null, modulePlans, relevantRulesData, dataAccessPlans = {}, serviceContractSeeds = [], actionContractSeeds = [], compositionChildQueries = [], compositionFormBindings = [], routeContracts = [], versionBucket = '', frameworkVersion = '' }) {
        const frameworkContext = {
            versionBucket: String(versionBucket || '').trim(),
            frameworkVersion: String(frameworkVersion || '').trim()
        };
        const ruleRefsByStory = new RequirementRulePoolService().buildStoryRuleRefs(requirementRulePool);
        const out = {
            schemaVersion: 'business-facts/v1',
            generatedAt: new Date().toISOString(),
            frameworkContext,
            stories: Object.fromEntries(Object.entries(this._buildStoriesIndexFromDesignDocument(designDocument))
                .map(([storyId, story]) => [storyId, { ...story, ruleRefs: ruleRefsByStory[storyId] || [] }])),
            businessFacts: {
                businessObjects: [],
                databaseTables: [],
                statisticsContracts: [],
                workflowContracts: [],
                constructionBindings: [],
                pageCompositions: [],
                queryFilters: [],
                compositionChildQueries: (Array.isArray(compositionChildQueries) ? compositionChildQueries : [])
                    .filter(item => item && typeof item === 'object')
                    .map(item => JSON.parse(JSON.stringify(item))),
                compositionFormBindings: (Array.isArray(compositionFormBindings) ? compositionFormBindings : [])
                    .filter(item => item && typeof item === 'object')
                    .map(item => JSON.parse(JSON.stringify(item)))
            },
            codingFactHandoff: [],
            acceptanceLedger: {
                scope: 'demand',
                items: []
            },
            rulePool: {
                scope: 'demand',
                confirmedRules: this._requirementRuleAliases(requirementRulePool),
                selfAuditBeforeWrite: [],
                apiUsageHints: [],
                unresolvedSignals: this._requirementUnresolvedSignals(requirementRulePool)
            },
            historicalEntryFiles: [],
            historicalBehaviorFacts: [],
            routeContracts: Array.isArray(routeContracts) ? routeContracts : [],
            dataAccessPlans: Object.values(dataAccessPlans || {}).filter(plan => plan && typeof plan === 'object'),
            serviceContractSeeds: (Array.isArray(serviceContractSeeds) ? serviceContractSeeds : []).filter(seed => seed && typeof seed === 'object'),
            actionContractSeeds: (Array.isArray(actionContractSeeds) ? actionContractSeeds : []).filter(seed => seed && typeof seed === 'object')
        };
        out.historicalEntryFiles = this._collectHistoricalEntryFiles(out.stories);
        out.historicalBehaviorFacts = this._collectHistoricalBehaviorFacts(out.stories);
        out.codingFactHandoff = this._collectCodingFactHandoff(out.stories);
        const storyBasedAcceptanceLedgerItems = this._buildStoryBasedAcceptanceLedgerItems(out.stories, designDocument);
        if (!designDocument || !Array.isArray(designDocument.modules)) {
            if (storyBasedAcceptanceLedgerItems.length > 0) {
                out.acceptanceLedger.items = storyBasedAcceptanceLedgerItems;
            }
            return out;
        }

        const tables = (designDocument.databaseDesign && Array.isArray(designDocument.databaseDesign.tables))
            ? designDocument.databaseDesign.tables
            : [];

        // 公共字段集（BaseEntity 自动处理；不暴露给 LLM 让它聚焦业务字段）
        const commonFieldNames = new Set([
            'rowguid', 'row_id',
            'operatedate', 'operateusername', 'operateuserguid',
            'operateuserouguid', 'operateuserbaseouguid',
            'yearflag', 'belongxiaqucode', 'pviguid'
        ]);

        // 预构建 entityName → 关联表 的索引：
        // 故事线：设计阶段 relatedModuleIds 只标记了"首次引入该表"的模块（如 MOD-01），
        // 但同一聚合根（同 entityName）的其它模块（如 编辑/查询/导出）操作的是同一张表。
        // 运行时链路：HtmlPage → initPage(Action) → @Autowired Service → Entity → @Entity(table=...)
        // 所以按 codingHandoff.entityName 就能确定模块操作哪张表。
        // 当 relatedModuleIds 匹配不到时，回退到按 entityName 找同实体的表。
        const entityNameToTablesMap = new Map();
        for (const m of designDocument.modules) {
            const eName = String(m && m.codingHandoff && m.codingHandoff.entityName || '').trim();
            const mId = String(m && m.moduleId || '').trim();
            if (!eName || !mId) continue;
            if (!entityNameToTablesMap.has(eName)) {
                // 找 relatedModuleIds 含本 moduleId 的表，关联到 entityName
                const matched = [];
                for (const table of tables) {
                    const related = Array.isArray(table.relatedModuleIds) ? table.relatedModuleIds : [];
                    if (related.indexOf(mId) !== -1) matched.push(table);
                }
                if (matched.length > 0) entityNameToTablesMap.set(eName, matched);
            }
        }

        const seenObjects = new Set();
        const seenTables = new Set();
        const seenStatisticsContracts = new Set();
        const seenWorkflowContracts = new Set();
        const seenAuditRules = new Set();
        const seenHints = new Set();

        for (const mod of designDocument.modules) {
            const moduleId = String(mod && mod.moduleId || '').trim();
            if (!moduleId) continue;
            const handoff = mod.codingHandoff && typeof mod.codingHandoff === 'object' && !Array.isArray(mod.codingHandoff)
                ? mod.codingHandoff
                : {};
            const stableObjectKey = String(this._pick(handoff.objectKey, mod.objectKey, mod.entityKey) || '').trim();
            const entityName = String(handoff.entityName || '').trim();
            const pageComposition = handoff.pageComposition && typeof handoff.pageComposition === 'object'
                ? handoff.pageComposition
                : (mod.pageComposition && typeof mod.pageComposition === 'object' ? mod.pageComposition : null);
            const queryFilters = Array.isArray(handoff.queryFilters)
                ? handoff.queryFilters
                : (Array.isArray(mod.queryFilters) ? mod.queryFilters : []);
            queryFilters.forEach(filter => {
                if (!filter || typeof filter !== 'object') return;
                out.businessFacts.queryFilters.push({ moduleId, ...JSON.parse(JSON.stringify(filter)) });
            });
            const moduleConstructionBindings = Array.isArray(handoff.constructionBindings)
                ? handoff.constructionBindings
                : (Array.isArray(mod.constructionBindings) ? mod.constructionBindings : []);
            moduleConstructionBindings.forEach(binding => {
                out.businessFacts.constructionBindings.push({
                    moduleId,
                    ...JSON.parse(JSON.stringify(binding))
                });
            });

            // 数据库表：找 relatedModuleIds 含本 moduleId 的表
            const databaseTables = [];
            let matchedTables = [];
            for (const table of tables) {
                const related = Array.isArray(table.relatedModuleIds) ? table.relatedModuleIds : [];
                const tableModuleId = String(table && (table.moduleId || table.sourceModuleId) || '').trim();
                const tableEntityName = String(table && table.entityName || '').trim();
                if (related.indexOf(moduleId) !== -1
                    || (tableModuleId && tableModuleId === moduleId)
                    || (entityName && tableEntityName && tableEntityName === entityName)) {
                    matchedTables.push(table);
                }
            }
            // 回退：按 codingHandoff.entityName 找同聚合根的表
            // 故事线：MOD-02（编辑）/MOD-05（查询）的 entityName 都是 "Place"，
            // 它们的 Action pageLoad 都通过 IGxhPlaceService → GxhPlace(@Entity table="xm_place_place")
            // 操作同一张表。relatedModuleIds 没标记它们，但 entityName 一样就该共享字段事实。
            if (matchedTables.length === 0) {
                if (entityName && entityNameToTablesMap.has(entityName)) {
                    matchedTables = entityNameToTablesMap.get(entityName);
                }
            }
            if (pageComposition && Array.isArray(pageComposition.blocks)) {
                const compositionObjectKeys = new Set(pageComposition.blocks
                    .map(block => String(block && block.objectKey || '').trim())
                    .filter(Boolean));
                tables.forEach(table => {
                    if (!compositionObjectKeys.has(String(table && table.objectKey || '').trim())) return;
                    if (!matchedTables.includes(table)) matchedTables.push(table);
                });
            }
            for (const table of matchedTables) {
                const rawBusinessColumns = Array.isArray(table.businessColumns || table.columns || table.fields)
                    ? (table.businessColumns || table.columns || table.fields)
                    : [];
                const businessColumns = rawBusinessColumns
                    .filter(col => col && col.name && !commonFieldNames.has(String(col.name).toLowerCase()))
                    .map(col => {
                        const item = {
                            name: col.name,
                            type: col.type || '',
                            length: col.length,
                            required: Object.prototype.hasOwnProperty.call(col, 'formRequired')
                                ? col.formRequired === true
                                : col.required === true,
                            comment: col.comment || ''
                        };
                        if (col.relationRef) item.relationRef = String(col.relationRef).trim();
                        if (typeof col.codeItem === 'string') {
                            const codeItem = col.codeItem.trim();
                            if (codeItem) {
                                item.codeItem = codeItem;
                                if (col.codeItemDefinition && typeof col.codeItemDefinition === 'object') {
                                    item.codeItemDefinition = JSON.parse(JSON.stringify(col.codeItemDefinition));
                                }
                            }
                        }
                        if (col.attachmentKey === true) {
                            item.attachmentKey = true;
                            const attachmentLabel = String(col.attachmentLabel || col.comment || '').trim();
                            if (attachmentLabel) item.attachmentLabel = attachmentLabel;
                        }
                        return item;
                    });
                databaseTables.push({
                    ...(table.objectKey ? { objectKey: table.objectKey } : {}),
                    tableName: table.tableName || '',
                    tableComment: table.tableComment || '',
                    primaryKey: table.primaryKey || '',
                    businessColumns,
                    // reuse 表透传：reusedApis + 物理路径，让 Coder 直接 read_file 看现有 Service 真实方法签名
                    ...(table.reuse === true ? { reuse: true } : {}),
                    ...(Array.isArray(table.reusedApis) && table.reusedApis.length > 0 ? { reusedApis: table.reusedApis } : {}),
                    ...(table.reuseSourceFile ? { reuseSourceFile: table.reuseSourceFile } : {}),
                    ...(Array.isArray(table.reuseDirHints) && table.reuseDirHints.length > 0 ? { reuseDirHints: table.reuseDirHints } : {})
                });
            }

            const businessObject = String(mod.businessObject || '').trim();
            const constructionSceneKey = this._pick(handoff.constructionSceneKey, mod.constructionSceneKey);
            const practiceSceneKeys = this._normalizeStringList(handoff.practiceSceneKeys, mod.practiceSceneKeys);
            const statisticsContracts = this._normalizeStatisticsContracts(
                handoff.statisticsContracts || mod.statisticsContracts,
                handoff.statisticsContract || mod.statisticsContract
            );
            const statisticsContract = statisticsContracts.length === 1
                ? this._stripStatisticsStoryRef(statisticsContracts[0])
                : null;
            const workflowContracts = this._normalizeWorkflowContracts(
                handoff.workflowContracts || mod.workflowContracts,
                handoff.workflowContract || mod.workflowContract
            );
            const workflowContract = workflowContracts.length === 1
                ? this._stripWorkflowStoryRef(workflowContracts[0])
                : null;
            const businessObjectIdentity = `${businessObject}::${entityName}`;
            if (pageComposition) {
                out.businessFacts.pageCompositions.push({
                    moduleId,
                    ...JSON.parse(JSON.stringify(pageComposition))
                });
            }
            if ((businessObject || entityName) && !seenObjects.has(businessObjectIdentity)) {
                seenObjects.add(businessObjectIdentity);
                out.businessFacts.businessObjects.push({
                    ...(stableObjectKey ? { objectKey: stableObjectKey } : {}),
                    businessObject,
                    entityName,
                    constructionSceneKey,
                    ...(mod.carriedByEntityKey ? { carriedByEntityKey: mod.carriedByEntityKey } : {}),
                    practiceSceneKeys,
                    ...(pageComposition ? { pageComposition: JSON.parse(JSON.stringify(pageComposition)) } : {}),
                    ...(moduleConstructionBindings.length > 0 ? { constructionBindings: moduleConstructionBindings } : {}),
                    ...(statisticsContract ? { statisticsContract } : {}),
                    ...(statisticsContracts.length > 0 ? { statisticsContracts } : {}),
                    ...(workflowContract ? { workflowContract } : {}),
                    ...(workflowContracts.length > 0 ? { workflowContracts } : {})
                });
            }
            for (const statisticsContractItem of statisticsContracts) {
                const statsKey = `${moduleId}::${String(statisticsContractItem.storyId || '').trim()}::${String(statisticsContractItem.title || '').trim()}`;
                if (!seenStatisticsContracts.has(statsKey)) {
                    seenStatisticsContracts.add(statsKey);
                    out.businessFacts.statisticsContracts.push({
                        moduleId,
                        businessObject,
                        entityName,
                        constructionSceneKey,
                        ...statisticsContractItem
                    });
                }
            }
            for (const workflowContractItem of workflowContracts) {
                const workflowKey = `${moduleId}::${String(workflowContractItem.storyId || '').trim()}::${String(workflowContractItem.processName || '').trim()}`;
                if (!seenWorkflowContracts.has(workflowKey)) {
                    seenWorkflowContracts.add(workflowKey);
                    out.businessFacts.workflowContracts.push({
                        moduleId,
                        ...(stableObjectKey ? { objectKey: stableObjectKey } : {}),
                        businessObject,
                        entityName,
                        constructionSceneKey,
                        ...workflowContractItem
                    });
                }
            }
            for (const table of databaseTables) {
                const tableKey = `${String(table.tableName || '').trim()}::${String(table.tableComment || '').trim()}`;
                if (!tableKey.trim() || seenTables.has(tableKey)) continue;
                seenTables.add(tableKey);
                out.businessFacts.databaseTables.push(table);
            }

            // acceptanceCriteria只保存不可变AC定义；编码进度由整需求实施计划记录。
            const ac = mod.acceptanceCriteria && typeof mod.acceptanceCriteria === 'object'
                ? mod.acceptanceCriteria
                : {};
            const tagAcceptanceItems = (group) => {
                const arr = Array.isArray(ac[group]) ? ac[group] : [];
                return arr.map((item, idx) => ({
                    code: `${moduleId}-${group}-${idx + 1}`,
                    group,
                    ...(item && typeof item === 'object' ? item : {})
                }));
            };
            const groupedAcceptanceItems = ACCEPTANCE_GROUPS.reduce((memo, group) => {
                memo[group] = tagAcceptanceItems(group);
                return memo;
            }, {});
            const acceptanceCriteria = {
                storyAcceptanceItems: ACCEPTANCE_GROUPS.flatMap(group => groupedAcceptanceItems[group]),
                happyPath: groupedAcceptanceItems.happyPath,
                exception: groupedAcceptanceItems.exception,
                boundary: groupedAcceptanceItems.boundary
            };
            flattenAcceptanceItems(acceptanceCriteria).forEach(entry => {
                const item = entry.item || {};
                out.acceptanceLedger.items.push({
                    code: entry.code,
                    group: entry.group,
                    scenario: String(item.scenario || '').trim(),
                    given: String(item.given || '').trim(),
                    when: String(item.when || '').trim(),
                    then: String(item.then || '').trim()
                });
            });

            // selfAuditBeforeWrite：从 relevant-rules.json 数据渲染（已按模块合并所有 fileKinds 的必读规则）
            const selfAuditBeforeWrite = this._renderSelfAuditFromRelevantRules(relevantRulesData, moduleId, frameworkContext);
            const apiUsageHints = this.ruleUsageHintService.buildModuleHints({
                relevantRulesData,
                moduleId,
                versionBucket: frameworkContext.versionBucket,
                frameworkVersion: frameworkContext.frameworkVersion
            });
            selfAuditBeforeWrite.forEach(item => {
                const ruleAlias = String(item && item.ruleAlias || '').trim();
                if (!ruleAlias || seenAuditRules.has(ruleAlias)) return;
                seenAuditRules.add(ruleAlias);
                out.rulePool.selfAuditBeforeWrite.push(item);
            });
            apiUsageHints.forEach(item => {
                const ruleAlias = String(item && item.ruleAlias || '').trim();
                if (!ruleAlias || seenHints.has(ruleAlias)) return;
                seenHints.add(ruleAlias);
                out.rulePool.apiUsageHints.push(item);
            });
        }
        if (storyBasedAcceptanceLedgerItems.length > 0) {
            out.acceptanceLedger.items = storyBasedAcceptanceLedgerItems;
        }
        return out;
    }

    _buildCompositionChildQueryContracts({ designDocument = {}, modulePlans = [], filePlan = [] } = {}) {
        const tables = designDocument.databaseDesign && Array.isArray(designDocument.databaseDesign.tables)
            ? designDocument.databaseDesign.tables
            : [];
        const tableByObjectKey = new Map(tables
            .map(table => [String(table && table.objectKey || '').trim(), table])
            .filter(([objectKey]) => objectKey));
        const filesByModuleId = new Map();
        for (const file of (Array.isArray(filePlan) ? filePlan : [])) {
            const moduleId = String(file && file.moduleId || '').trim();
            if (!moduleId) continue;
            if (!filesByModuleId.has(moduleId)) filesByModuleId.set(moduleId, []);
            filesByModuleId.get(moduleId).push(file);
        }

        const contracts = [];
        const formBindings = [];
        const issues = [];
        for (const parentModule of (Array.isArray(modulePlans) ? modulePlans : [])) {
            const moduleId = String(parentModule && parentModule.moduleId || '').trim();
            const composition = parentModule && parentModule.pageComposition && typeof parentModule.pageComposition === 'object'
                ? parentModule.pageComposition
                : null;
            if (!composition || !Array.isArray(composition.blocks)) continue;
            const parentObjectKey = String(composition.formObjectKey || '').trim();
            const parentTable = tableByObjectKey.get(parentObjectKey);
            const parentKeyField = String(parentTable && parentTable.primaryKey || '').trim();
            // 入口模块和实际表单模块可以不同；Action保留入口命名，但dataBean/Service必须来自formObjectKey。
            const parentRelatedModuleIds = parentTable && Array.isArray(parentTable.relatedModuleIds)
                ? parentTable.relatedModuleIds.map(item => String(item || '').trim()).filter(Boolean)
                : [];
            const formModule = (Array.isArray(modulePlans) ? modulePlans : []).find(candidate => {
                const candidateId = String(candidate && candidate.moduleId || '').trim();
                if (!parentRelatedModuleIds.includes(candidateId)) return false;
                const files = filesByModuleId.get(candidateId) || [];
                return files.some(file => String(file && file.fileKind || '').trim() === 'Entity')
                    && files.some(file => String(file && file.fileKind || '').trim() === 'ServiceApi');
            });
            const parentModuleId = String(formModule && formModule.moduleId || '').trim();
            const parentFiles = filesByModuleId.get(parentModuleId) || [];
            const parentEntityFile = parentFiles.find(file => String(file && file.fileKind || '').trim() === 'Entity');
            const parentServiceFile = parentFiles.find(file => String(file && file.fileKind || '').trim() === 'ServiceApi');
            const parentEntityImport = this._javaImportFromResolvedPath(parentEntityFile && parentEntityFile.resolvedPath);
            const parentServiceImport = this._javaImportFromResolvedPath(parentServiceFile && parentServiceFile.resolvedPath);
            const parentEntityType = parentEntityImport.split('.').pop() || '';
            const parentServiceType = parentServiceImport.split('.').pop() || '';
            const parentServiceField = this._compositionChildServiceField('', parentEntityType);
            const formRequiredFacts = [
                ['formObjectKey', parentObjectKey],
                ['formModuleId', parentModuleId],
                ['formEntityType', parentEntityType],
                ['formEntityImport', parentEntityImport],
                ['formServiceType', parentServiceType],
                ['formServiceImport', parentServiceImport],
                ['formServiceField', parentServiceField]
            ];
            formRequiredFacts.forEach(([field, value]) => {
                if (String(value || '').trim()) return;
                issues.push({
                    moduleId,
                    formObjectKey: parentObjectKey,
                    field,
                    projectionKind: 'form_binding',
                    reason: 'Builder 无法从 databaseDesign + filePlan 机械投影表单承载合同'
                });
            });
            if (!formRequiredFacts.some(([, value]) => !String(value || '').trim())) {
                formBindings.push({
                    moduleId,
                    formObjectKey: parentObjectKey,
                    formModuleId: parentModuleId,
                    formEntityType: parentEntityType,
                    formEntityImport: parentEntityImport,
                    formServiceType: parentServiceType,
                    formServiceImport: parentServiceImport,
                    formServiceField: parentServiceField
                });
            }

            for (const block of composition.blocks) {
                const kind = String(block && block.kind || '').trim();
                if (kind !== 'child_edit' && kind !== 'child_readonly') continue;
                const childObjectKey = String(block && block.objectKey || '').trim();
                const relationPath = Array.isArray(block && block.relationPath)
                    ? block.relationPath.map(item => String(item || '').trim()).filter(Boolean)
                    : [];
                const relationKey = relationPath.length === 1 ? relationPath[0] : '';
                const childTable = tableByObjectKey.get(childObjectKey);
                const columns = childTable && Array.isArray(childTable.columns || childTable.businessColumns || childTable.fields)
                    ? (childTable.columns || childTable.businessColumns || childTable.fields)
                    : [];
                const foreignKeyField = String((columns.find(column =>
                    String(column && column.relationRef || '').trim() === relationKey
                ) || {}).name || '').trim();
                const relatedModuleIds = childTable && Array.isArray(childTable.relatedModuleIds)
                    ? childTable.relatedModuleIds.map(item => String(item || '').trim()).filter(Boolean)
                    : [];
                const childModule = (Array.isArray(modulePlans) ? modulePlans : []).find(candidate => {
                    const candidateId = String(candidate && candidate.moduleId || '').trim();
                    if (!relatedModuleIds.includes(candidateId)) return false;
                    const files = filesByModuleId.get(candidateId) || [];
                    return files.some(file => String(file && file.fileKind || '').trim() === 'Entity')
                        && files.some(file => String(file && file.fileKind || '').trim() === 'ServiceApi');
                });
                const childModuleId = String(childModule && childModule.moduleId || '').trim();
                const childFiles = filesByModuleId.get(childModuleId) || [];
                const entityFile = childFiles.find(file => String(file && file.fileKind || '').trim() === 'Entity');
                const serviceFile = childFiles.find(file => String(file && file.fileKind || '').trim() === 'ServiceApi');
                const childEntityImport = this._javaImportFromResolvedPath(entityFile && entityFile.resolvedPath);
                const childServiceImport = this._javaImportFromResolvedPath(serviceFile && serviceFile.resolvedPath);
                const childEntityType = childEntityImport.split('.').pop() || '';
                const childServiceType = childServiceImport.split('.').pop() || '';
                const childServiceField = this._compositionChildServiceField(
                    parentEntityType,
                    childEntityType
                );
                const requiredFacts = [
                    ['primaryObjectKey', parentObjectKey],
                    ['parentKeyField', parentKeyField],
                    ['parentEntityType', parentEntityType],
                    ['childObjectKey', childObjectKey],
                    ['relationPath', relationPath.length === 1 ? relationPath[0] : ''],
                    ['foreignKeyField', foreignKeyField],
                    ['childModuleId', childModuleId],
                    ['childEntityImport', childEntityImport],
                    ['childServiceImport', childServiceImport],
                    ['childServiceField', childServiceField]
                ];
                requiredFacts.forEach(([field, value]) => {
                    if (String(value || '').trim()) return;
                    issues.push({
                        moduleId,
                        childObjectKey,
                        relationPath,
                        field,
                        projectionKind: 'child_query',
                        reason: 'Builder 无法从 databaseDesign + filePlan 机械投影该字段'
                    });
                });
                if (requiredFacts.some(([, value]) => !String(value || '').trim())) continue;

                contracts.push({
                    moduleId,
                    childObjectKey,
                    relationPath,
                    relationKind: 'direct_foreign_key',
                    parentEntityType,
                    childEntityType,
                    childEntityImport,
                    childServiceType,
                    childServiceImport,
                    childServiceField,
                    foreignKeyField,
                    parentKeyField,
                    queryMethod: 'paginatorList'
                });
            }
        }
        if (issues.length > 0) {
            const formProjectionMissing = issues.some(issue => issue.projectionKind === 'form_binding');
            return this._blocked(
                formProjectionMissing
                    ? 'DESIGN_TDD_COMPOSITION_FORM_PROJECTION_MISSING'
                    : 'DESIGN_TDD_COMPOSITION_CHILD_QUERY_PROJECTION_MISSING',
                formProjectionMissing
                    ? '复合页面实际表单Entity/Service无法完整投影，禁止退化为入口对象单表表单。'
                    : '复合页面子表查询合同无法完整投影，禁止生成 emptyList 占位实现。',
                {
                    source: 'design_tdd_build_plan',
                    issues,
                    allowedNextActions: ['repair_design_builder_projection_and_rerun_design_tdd_build_plan'],
                    forbiddenNextActions: ['materialize_placeholder_child_query', 'ask_coder_to_guess_entity_or_foreign_key']
                }
            );
        }
        return { ok: true, contracts, formBindings };
    }

    _javaImportFromResolvedPath(resolvedPath = '') {
        const normalized = String(resolvedPath || '').trim().replace(/\\/g, '/');
        const match = normalized.match(/(?:^|\/)src\/main\/java\/(.+)\.java$/i);
        return match ? match[1].replace(/\//g, '.') : '';
    }

    _compositionChildServiceField(parentEntityType = '', childEntityType = '') {
        const parent = String(parentEntityType || '').trim();
        const child = String(childEntityType || '').trim();
        if (!child) return '';
        let commonLength = 0;
        while (commonLength < parent.length
            && commonLength < child.length
            && parent[commonLength] === child[commonLength]) {
            commonLength += 1;
        }
        while (commonLength > 0 && child[commonLength] && !/[A-Z]/.test(child[commonLength])) {
            commonLength -= 1;
        }
        const businessType = child.slice(commonLength) || child;
        return businessType.slice(0, 1).toLowerCase() + businessType.slice(1) + 'Service';
    }

    _buildStoryBasedAcceptanceLedgerItems(stories = {}, designDocument = {}) {
        const storyIds = Object.keys(stories || {});
        if (storyIds.length === 0) return [];
        const storyToModuleId = this._buildStoryToModuleIdMap(designDocument);
        const modulesById = new Map((Array.isArray(designDocument && designDocument.modules) ? designDocument.modules : [])
            .map(mod => [String(mod && mod.moduleId || '').trim(), mod])
            .filter(([moduleId]) => moduleId));
        const ledgerItems = [];

        storyIds.forEach((storyId, storyIndex) => {
            const story = stories[storyId] || {};
            const boundModuleId = storyToModuleId.get(storyId) || '';
            const codePrefix = storyId || `STORY-${String(storyIndex + 1).padStart(2, '0')}`;
            const sourceType = boundModuleId ? 'businessEntity' : 'existingAdjustment';
            const sourceModuleId = boundModuleId || '';
            let normalized = this._normalizeStoryAcceptanceCriteria(story.acceptanceCriteria);
            const hasStoryAcceptance = ACCEPTANCE_GROUPS.some(group => Array.isArray(normalized[group]) && normalized[group].length > 0);
            if (!hasStoryAcceptance && boundModuleId && modulesById.has(boundModuleId)) {
                normalized = this._normalizeStoryAcceptanceCriteria(modulesById.get(boundModuleId).acceptanceCriteria);
            }
            const codedGroups = { happyPath: [], exception: [], boundary: [] };
            const userStory = String(story.userStory || '').trim();

            ACCEPTANCE_GROUPS.forEach(group => {
                const arr = Array.isArray(normalized[group]) ? normalized[group] : [];
                arr.forEach((item, itemIndex) => {
                    const sequence = itemIndex + 1;
                    const codedItem = {
                        code: `${codePrefix}-${group}-${sequence}`,
                        storyId,
                        userStory,
                        group,
                        scenario: String(item && item.scenario || '').trim(),
                        given: String(item && item.given || '').trim(),
                        when: String(item && item.when || '').trim(),
                        then: String(item && item.then || '').trim(),
                        sourceStoryId: storyId,
                        sourceType,
                        ...(sourceModuleId ? { sourceModuleId } : {})
                    };
                    codedGroups[group].push(codedItem);
                    ledgerItems.push({ ...codedItem });
                });
            });

            story.acceptanceCriteria = codedGroups;
        });

        return ledgerItems;
    }

    _buildStoryToModuleIdMap(designDocument = {}) {
        const out = new Map();
        const modules = Array.isArray(designDocument && designDocument.modules) ? designDocument.modules : [];
        const entities = Array.isArray(designDocument && designDocument.businessEntities) ? designDocument.businessEntities : [];
        entities.forEach((entity, index) => {
            const moduleId = String(modules[index] && modules[index].moduleId || `MOD-${String(index + 1).padStart(2, '0')}`).trim();
            if (!moduleId) return;
            (Array.isArray(entity && entity.relatedStoryIds) ? entity.relatedStoryIds : []).forEach(storyId => {
                const normalizedStoryId = String(storyId || '').trim().toUpperCase();
                if (normalizedStoryId && !out.has(normalizedStoryId)) out.set(normalizedStoryId, moduleId);
            });
            (Array.isArray(entity && entity.relatedStories) ? entity.relatedStories : []).forEach(story => {
                const normalizedStoryId = String(story && (story.storyId || story.id) || '').trim().toUpperCase();
                if (normalizedStoryId && !out.has(normalizedStoryId)) out.set(normalizedStoryId, moduleId);
            });
        });
        modules.forEach(mod => {
            const moduleId = String(mod && mod.moduleId || '').trim();
            if (!moduleId) return;
            const storyId = String(mod && (mod.storyId || mod.id) || '').trim().toUpperCase();
            if (storyId && !out.has(storyId)) out.set(storyId, moduleId);
            (Array.isArray(mod && mod.relatedStories) ? mod.relatedStories : []).forEach(story => {
                const relatedStoryId = String(story && (story.storyId || story.id) || '').trim().toUpperCase();
                if (relatedStoryId && !out.has(relatedStoryId)) out.set(relatedStoryId, moduleId);
            });
        });
        return out;
    }

    /**
     * 从 relevant-rules.json 的内存对象渲染 selfAuditBeforeWrite。
     * 与 design-tdd-skeleton-service._buildSelfAuditChecklist 保持渲染逻辑一致。
     */
    _renderSelfAuditFromRelevantRules(relevantRulesData, moduleId, versionContext = '') {
        try {
            if (!relevantRulesData || !relevantRulesData.modules) return [];
            const rules = this._relevantRulesForModule(relevantRulesData, moduleId);
            if (rules.length === 0) return [];
            const templateRuleAliases = new Set(this.ruleUsageHintService.requiredRulesConfigService.getAllTemplateRuleAliases(versionContext));
            return rules
                .filter(rule => rule && rule.ruleAlias && rule.foundStatus !== 'not_found')
                .filter(rule => {
                    const alias = String(rule.ruleAlias || '').trim();
                    return !templateRuleAliases.has(alias);
                })
                .map(rule => {
                    const ruleAlias = rule.ruleAlias;
                    const intentKeywords = Array.isArray(rule.intentKeywords) ? rule.intentKeywords : [];
                    const description = String(rule.description || '').trim();
                    const intentText = intentKeywords.length > 0
                        ? intentKeywords.slice(0, 6).join('/')
                        : ruleAlias;
                    return {
                        ruleAlias,
                        askYourself: `本段代码是否涉及 ${intentText} ？`,
                        ifYes: `先读 readCatalog.resources 中已登记的本地规则正文；本地正文缺失时才调 rule_expert(action=read, ruleName="${ruleAlias}", outputMode=full)`,
                        ifNo: '跳过本条',
                        description,
                        ruleFilePath: rule.filePath || '',
                        intentKeywords
                    };
                });
        } catch (_) {
            return [];
        }
    }

    _relevantRulesForModule(relevantRulesData = {}, moduleId = '') {
        const key = String(moduleId || '').trim();
        if (!key || !relevantRulesData || typeof relevantRulesData !== 'object') return [];
        const moduleEntry = relevantRulesData.modules && relevantRulesData.modules[key];
        if (!moduleEntry || typeof moduleEntry !== 'object') return [];
        const rulesByAlias = relevantRulesData.rulesByAlias && typeof relevantRulesData.rulesByAlias === 'object'
            ? relevantRulesData.rulesByAlias
            : {};
        const refs = Array.isArray(moduleEntry.ruleRefs) ? moduleEntry.ruleRefs : [];
        return refs
            .map(ref => String(ref && ref.ruleAlias || ref || '').trim())
            .filter(Boolean)
            .map(alias => rulesByAlias[alias] || { ruleAlias: alias, foundStatus: 'not_found' });
    }

    /**
     * 把 dedup 后的 filePlan 按 owner 模块分组，给 design_tdd_skeleton_materialize 反查
     * "本模块还差哪个 fileKind 没物化"用。
     *
     * 排序约定（owner 物化顺序）：
     *   Entity → ServiceApi → ServiceInternal → ServiceImpl → Action → HtmlPage
     * Builder 把这个排序固化下来，LLM 物化时按这个顺序走，不需要自己想"先做哪个"。
     */
    _buildModulesOwnerFiles(filePlan, modulePlans, projectPath = '', dataAccessPlans = {}) {
        // 兼容历史测试/调用者；生产投影唯一委托到 DesignTddTargetProjection。
        return this.targetProjection.buildModulesOwnerFiles(filePlan, modulePlans, projectPath, dataAccessPlans);
    }

    _buildStoryWorkPackages(modulesOwnerFiles = []) {
        // 兼容历史测试/调用者；生产投影唯一委托到 DesignTddTargetProjection。
        return this.targetProjection.buildStoryWorkPackages(modulesOwnerFiles);
    }

    _verifyStoryWorkPackageProjection(modulesOwnerFiles = [], storyWorkPackages = []) {
        // 兼容历史测试/调用者；生产投影唯一委托到 DesignTddTargetProjection。
        return this.targetProjection.verifyStoryWorkPackageProjection(modulesOwnerFiles, storyWorkPackages);
    }

    _shouldSkipCrudAutoComplete(seed = {}) {
        if (seed && (seed.queryOnly === true || seed.statisticsOnly === true)) return true;
        const targetPageRole = String(seed && seed.targetPageRole || '').trim();
        if (QUERY_ONLY_TARGET_PAGE_ROLES.includes(targetPageRole)) return true;
        const carrier = seed && seed.interactionCarrier && typeof seed.interactionCarrier === 'object' && !Array.isArray(seed.interactionCarrier)
            ? seed.interactionCarrier
            : null;
        const carrierKind = String(carrier && carrier.kind || '').trim();
        const role = String(carrier && carrier.targetPageRole || '').trim();
        return carrierKind === 'dialog_page' && QUERY_ONLY_TARGET_PAGE_ROLES.includes(role);
    }

    _isRestInterfaceScene(module = {}, handoff = null) {
        const currentHandoff = handoff || this._getHandoff(module);
        return String(this._pick(
            currentHandoff && currentHandoff.constructionSceneKey,
            module && module.constructionSceneKey
        ) || '').trim() === 'rest_interface';
    }

    _isWorkflowProcessScene(module = {}, handoff = null) {
        const currentHandoff = handoff || this._getHandoff(module);
        return String(this._pick(
            currentHandoff && currentHandoff.constructionSceneKey,
            module && module.constructionSceneKey,
            module && module.businessContext && module.businessContext.constructionSceneKey
        ) || '').trim() === 'workflow_process';
    }

    _isCarriedOnlyModule(module = {}, handoff = null) {
        const currentHandoff = handoff || this._getHandoff(module);
        const carriedByModuleId = String(this._pick(
            currentHandoff && currentHandoff.carriedByModuleId,
            module && module.carriedByModuleId,
            module && module.businessContext && module.businessContext.carriedByModuleId
        ) || '').trim();
        return Boolean(carriedByModuleId) && !this._isWorkflowProcessScene(module, currentHandoff);
    }

    _buildSkeletonComposition(modulesOwnerFiles = []) {
        const modules = [];
        for (const moduleEntry of (Array.isArray(modulesOwnerFiles) ? modulesOwnerFiles : [])) {
            const moduleId = String(moduleEntry && moduleEntry.moduleId || '').trim();
            const ownerFiles = Array.isArray(moduleEntry && moduleEntry.ownerFiles) ? moduleEntry.ownerFiles : [];
            if (!moduleId || ownerFiles.length === 0) continue;
            const units = [];
            const entityFile = ownerFiles.find(file => file && file.fileKind === 'Entity');
            if (entityFile) {
                units.push(this._buildSkeletonUnit(moduleId, 'Entity', [entityFile], {
                    materializeMode: 'single_file'
                }));
            }
            const serviceFiles = SERVICE_BUNDLE_KINDS
                .map(kind => ownerFiles.find(file => file && file.fileKind === kind))
                .filter(Boolean);
            if (serviceFiles.length > 0) {
                units.push(this._buildSkeletonUnit(moduleId, 'ServiceBundle', serviceFiles, {
                    displayName: 'ServiceApi + ServiceInternal + ServiceImpl',
                    materializeMode: 'sequential_files',
                    requiredFileKinds: SERVICE_BUNDLE_KINDS.slice(),
                    complete: SERVICE_BUNDLE_KINDS.every(kind => serviceFiles.some(file => file.fileKind === kind))
                }));
            }
            ownerFiles
                .filter(file => file && file.fileKind === 'Rest')
                .forEach(file => {
                    units.push(this._buildSkeletonUnit(moduleId, 'Rest', [file], {
                        materializeMode: 'single_file'
                    }));
                });
            ownerFiles
                .filter(file => file && file.fileKind === 'Job')
                .forEach(file => {
                    units.push(this._buildSkeletonUnit(moduleId, 'Job', [file], {
                        materializeMode: 'single_file'
                    }));
                });
            ownerFiles
                .filter(file => file && file.fileKind === 'Action')
                .sort((a, b) => (CRUD_SUBTYPE_ORDER[String(a.subType || '').toLowerCase()] || 99)
                    - (CRUD_SUBTYPE_ORDER[String(b.subType || '').toLowerCase()] || 99))
                .forEach(file => {
                    units.push(this._buildSkeletonUnit(moduleId, 'Action', [file], {
                        subType: String(file.subType || 'list').trim().toLowerCase() || 'list',
                        materializeMode: 'single_file'
                    }));
                });
            ownerFiles
                .filter(file => file && file.fileKind === 'HtmlPage')
                .sort((a, b) => (CRUD_SUBTYPE_ORDER[String(a.subType || '').toLowerCase()] || 99)
                    - (CRUD_SUBTYPE_ORDER[String(b.subType || '').toLowerCase()] || 99))
                .forEach(file => {
                    units.push(this._buildSkeletonUnit(moduleId, 'HtmlPage', [file], {
                        subType: String(file.subType || '').trim().toLowerCase(),
                        materializeMode: 'single_file'
                    }));
                });
            modules.push({
                moduleId,
                businessContext: moduleEntry.businessContext || {},
                unitCount: units.length,
                units
            });
        }
        return {
            schemaVersion: 'skeleton-composition/v1',
            splitModel: {
                Entity: 'single_file',
                ServiceBundle: 'ServiceApi + ServiceInternal + ServiceImpl',
                Rest: 'single_file',
                Job: 'single_file',
                Action: 'split_by_subType(list/mylist/add/edit/detail/workflow)',
                HtmlPage: 'split_by_subType(list/mylist/add/edit/detail/workflow/workflowdetail)'
            },
            modules
        };
    }

    _buildSkeletonUnit(moduleId = '', unitType = '', files = [], extras = {}) {
        const subType = String(extras.subType || '').trim().toLowerCase();
        const normalizedFiles = (Array.isArray(files) ? files : []).map(file => ({
            fileKind: file.fileKind,
            ...(file.subType ? { subType: file.subType } : {}),
            ...(file.queryOnly === true ? { queryOnly: true } : {}),
            ...(file.statisticsOnly === true ? { statisticsOnly: true } : {}),
            ...(file.targetPageRole ? { targetPageRole: file.targetPageRole } : {}),
            ...(file.interactionCarrier ? { interactionCarrier: file.interactionCarrier } : {}),
            ...(file.sectionKey ? { sectionKey: file.sectionKey } : {}),
            ...(file.dataAccessPlanRef ? { dataAccessPlanRef: file.dataAccessPlanRef } : {}),
            resolvedPath: file.resolvedPath,
            operation: file.operation || 'create',
            evidenceRef: file.evidenceRef || moduleId,
            materializeArgs: {
                moduleId,
                fileKind: file.fileKind,
                targetFile: file.resolvedPath
            }
        }));
        return {
            unitId: [moduleId, unitType, subType].filter(Boolean).join(':'),
            unitType,
            ...(subType ? { subType } : {}),
            materializeMode: extras.materializeMode || 'single_file',
            ...(extras.displayName ? { displayName: extras.displayName } : {}),
            ...(Array.isArray(extras.requiredFileKinds) ? { requiredFileKinds: extras.requiredFileKinds } : {}),
            ...(typeof extras.complete === 'boolean' ? { complete: extras.complete } : {}),
            files: normalizedFiles
        };
    }

    /**
     * 找第一个 owner 文件并组装 design_tdd_skeleton_materialize 的 callTemplate。
     *
     * 找法：filePlan 已经是 dedup 后的 owner-only 列表，按 plan 顺序取第一个。
     * substitutions 由 Builder 完整给出（{EntityName}/{pagename}），{项目}/{模块} 等路径占位符
     * 在 materialize 内部会自动从 targetFile 派生，不必在 callTemplate 里出现。
     *
     * 失败容忍：filePlan 为空、找不到对应 intentLock 等情况返回 null，不阻断 buildPlan 主路径。
     */
    _buildFirstOwnerMaterializeTemplate({ args, filePlan, intentLocks, frameworkBucket }) {
        try {
            if (!Array.isArray(filePlan) || filePlan.length === 0) return null;
            // owner 文件的顺序：Entity → ServiceApi → ServiceInternal → ServiceImpl → Action → HtmlPage
            // filePlan 是按模块 + fileSeed 顺序推进的，第一项就是第一个 owner（自动补全的 ServiceInternal 排在末尾）
            const SKELETON_KINDS = new Set(['Entity', 'ServiceApi', 'ServiceInternal', 'ServiceImpl', 'Rest', 'Job', 'Action', 'HtmlPage']);
            const first = filePlan.find(f => SKELETON_KINDS.has(String(f.fileKind || '')));
            if (!first) return null;

            const moduleId = first.moduleId;
            const fileKind = first.fileKind;
            // targetFile 必须是绝对路径：LLM 拿到 callTemplate 复制粘贴时，
            // MCP 客户端 cwd 不一定等于 projectPath，相对路径会被错解析到客户端 cwd 下。
            const projectPath = String(args && args.projectPath || '').trim();
            const targetFile = path.isAbsolute(first.resolvedPath)
                ? first.resolvedPath
                : path.resolve(projectPath, first.resolvedPath);
            // AGENTS.md "确定事实不进 LLM 视野"：substitutions 字段已废弃，
            // Builder 在 materialize 入口直接从 plan.json 派生 {EntityName}/{pagename}，
            // LLM 不需要也不应该再传 substitutions。callTemplate 不再带这个字段。
            // sectionKey 同样是 Builder-owned 确定事实，由 materialize 入口按 plan.json 自动派生，
            // 不再让 LLM 复制规则模板章节名。
            const inlineArgs = {
                projectPath,
                skillName: 'epoint-design-tdd-coder',
                moduleId,
                fileKind,
                targetFile
            };
            return {
                moduleId,
                fileKind,
                targetFile,
                toolCall: buildMcpToolCall('design_tdd_skeleton_materialize', inlineArgs),
                callTemplate: `design_tdd_skeleton_materialize(${JSON.stringify(inlineArgs)})`
            };
        } catch (_) {
            return null;
        }
    }

    /**
     * fileKind 对应的默认 sectionKey。
     * 后端 5 件套 sectionKey 等于 fileKind；HtmlPage 按 subType 决定。
     */
    _defaultSectionKeyForFileKind(fileKind, fileEntry) {
        return resolveSkeletonSectionKey(fileKind, fileEntry);
    }

    _validateCodingHandoff(modules = [], htmlContract = {}, designDocument = {}, navigationContract = {}) {
        const result = this.codingHandoffService.validateDesignHandoff(designDocument, navigationContract);
        // 优先用 service 已经提供的 missingModules + repairCards（旧 module 形态走 _validateLegacyModulesShape）
        if (result && result.ok === false && Array.isArray(result.missingModules) && result.missingModules.length > 0) {
            return result;
        }
        // entity 形态：从 issues 派生 missingModules + repairCards 兼容形态
        if (result && result.ok === false) {
            const issues = (result.preflightLayer && Array.isArray(result.preflightLayer.issues)) ? result.preflightLayer.issues : [];
            const grouped = new Map();
            issues.forEach(issue => {
                const key = issue.entityKey || '$root';
                if (!grouped.has(key)) grouped.set(key, []);
                grouped.get(key).push(issue);
            });
            const missingModules = Array.from(grouped.entries()).map(([key, items]) => ({
                moduleId: key === '$root' ? '' : key,
                entityKey: key === '$root' ? '' : key,
                missing: items.map(i => {
                    const path = String(i.path || '');
                    if (path.endsWith('.businessEntities')) return 'codingHandoff.bizModule';
                    if (path.endsWith('.entityKey')) return 'codingHandoff.bizModule';
                    if (path.endsWith('.domain')) return 'codingHandoff.bizModule';
                    if (path.endsWith('.carriedByEntityKey')) return 'carriedByEntityKey';
                    if (i.code && i.code.startsWith('PREFLIGHT_BUSINESS_ENTITIES')) return 'codingHandoff.bizModule';
                    return path || i.code || 'unknown';
                }),
                issues: items
            }));
            const repairCards = missingModules.map(item => ({
                cardId: `coding-handoff-repair:${item.moduleId || item.entityKey || '$root'}`,
                moduleId: item.moduleId,
                entityKey: item.entityKey,
                missing: item.missing,
                repairTemplate: {},
                instruction: '回到 epoint-requirement-design 修 设计文档.json：补齐 entity 必填字段（entityKey/displayName/businessObject/domain/bizModule/relatedStoryIds/linkedTable）。'
            }));
            return {
                ok: false,
                missingModules,
                repairCards
            };
        }
        return result;
    }

    _requirementRuleAliases(requirementRulePool = null) {
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
        const pool = requirementRulePool && typeof requirementRulePool === 'object' && !Array.isArray(requirementRulePool)
            ? requirementRulePool
            : {};
        (Array.isArray(pool.globalWhitelist) ? pool.globalWhitelist : []).forEach(pushAlias);
        if (out.length > 0) return out;
        (Array.isArray(pool.storyRuleRecalls) ? pool.storyRuleRecalls : []).forEach(storyRecall => {
            (Array.isArray(storyRecall && storyRecall.acceptedRules) ? storyRecall.acceptedRules : []).forEach(pushAlias);
        });
        return out;
    }

    _requirementUnresolvedSignals(requirementRulePool = null) {
        const pool = requirementRulePool && typeof requirementRulePool === 'object' && !Array.isArray(requirementRulePool)
            ? requirementRulePool
            : {};
        const out = [];
        const seen = new Set();
        const pushSignal = (signal = {}, storyId = '') => {
            const normalized = {
                storyId: String(signal.storyId || storyId || '').trim().toUpperCase(),
                signal: String(signal.signal || '').trim(),
                userAnchor: String(signal.userAnchor || '').trim(),
                usageDuty: String(signal.usageDuty || '').trim(),
                source: String(signal.source || '').trim(),
                reason: String(signal.reason || '').trim()
            };
            const key = `${normalized.storyId}::${normalized.signal}::${normalized.userAnchor}`;
            if (!normalized.signal || seen.has(key)) return;
            seen.add(key);
            out.push(normalized);
        };
        (Array.isArray(pool.unresolvedSignals) ? pool.unresolvedSignals : []).forEach(signal => pushSignal(signal));
        (Array.isArray(pool.storyRuleRecalls) ? pool.storyRuleRecalls : []).forEach(storyRecall => {
            const storyId = String(storyRecall && storyRecall.storyId || '').trim().toUpperCase();
            (Array.isArray(storyRecall && storyRecall.unresolvedSignals) ? storyRecall.unresolvedSignals : [])
                .forEach(signal => pushSignal(signal, storyId));
        });
        return out;
    }

    /**
     * 构建并落盘 relevant-rules.json。
     *
     * 合并逻辑：
     *   - 公共映射：FILE_KIND_MUST_READ_RULES[fileKind]（fileKind 模板级必读，如 Action 必带
     *     UserSession / SqlConditionUtil）
     *   - 项目映射：需求阶段已确认 rule-pool.json.globalWhitelist（业务相关，按需求/Story 归因）
     *   - 按 moduleId 取 fileKind 集合（**走 _normalizeFileSeeds，含 Builder 后端 4 件套自动补全**，
     *     设计阶段漏 ServiceInternal 时这里也会带上 ServiceInternal 的必读规则）
     *
     * 返回 { ok, path?, errorCode?, message? }，失败不阻断 buildPlan 主路径。
     */
    _buildAndWriteRelevantRules({ context, designDocument, modulePlans, projectPath }) {
        try {
            // 从 context 自己取 versionBucket（来自 框架版本档位.json，scan 阶段已固定）。
            // 不让 LLM 传——这是确定事实，AGENTS.md 红线"确定事实不进 LLM 视野"。
            const frameworkBucket = (context.loadedArtifacts && context.loadedArtifacts.frameworkBucket) || {};
            const frameworkContext = this._extractFrameworkContext(frameworkBucket);
            const versionBucket = frameworkContext.versionBucket;
            const fileKindMustReadMap = this.ruleUsageHintService.requiredRulesConfigService
                .getFileKindRequiredRulesMap(frameworkContext);

            const demandRuleAliases = this._requirementRuleAliases(
                context.loadedArtifacts && context.loadedArtifacts.requirementRulePool
            );

            // 每个模块用到的 fileKind 集合：**走 _normalizeFileSeeds**，自动包含 Builder 补的 ServiceInternal
            // 这样 fileKindMustReadMap[ServiceInternal] = ['代码生成规范-后端实体层'] 也会进 selfAuditBeforeWrite
            const fileKindsByModule = new Map();
            for (const mod of (designDocument.modules || [])) {
                const moduleId = String(mod && mod.moduleId || '').trim();
                if (!moduleId) continue;
                const handoff = (mod.codingHandoff && typeof mod.codingHandoff === 'object') ? mod.codingHandoff : {};
                const kinds = new Set();
                for (const seed of this._normalizeFileSeeds(handoff, {
                    constructionSceneKey: this._pick(handoff.constructionSceneKey, mod.constructionSceneKey),
                    carriedByModuleId: this._pick(handoff.carriedByModuleId, mod.carriedByModuleId),
                    module: mod,
                    designDocument,
                    projectPath
                })) {
                    const k = String(seed && seed.fileKind || '').trim();
                    if (k) kinds.add(k);
                }
                if (Array.isArray(handoff.htmlPages) && handoff.htmlPages.length > 0) {
                    kinds.add('HtmlPage');
                }
                fileKindsByModule.set(moduleId, Array.from(kinds));
            }

            // 合并公共映射 + 项目映射 → Coder 按模块施工时的规则引用投影
            const moduleRuleSelections = [];
            for (const moduleId of new Set([
                ...fileKindsByModule.keys()
            ])) {
                const fileKinds = fileKindsByModule.get(moduleId) || [];
                const aliasSet = new Set();
                // 公共映射先入（fileKind 模板级，跨项目通用）
                for (const fk of fileKinds) {
                    const list = Array.isArray(fileKindMustReadMap[fk]) ? fileKindMustReadMap[fk] : [];
                    for (const alias of list) aliasSet.add(alias);
                }
                // 需求级业务规则后入：模块只是施工调度单位，不再裁判业务规则真值。
                for (const alias of demandRuleAliases) aliasSet.add(alias);

                moduleRuleSelections.push({
                    moduleId,
                    ruleSelections: Array.from(aliasSet).map(ruleAlias => ({ ruleAlias }))
                });
            }

            const result = this.relevantRulesBuilderService.build({
                moduleRuleSelections,
                projectPath,
                versionBucket,
                ruleService: this.ruleService
            });
            if (!result.ok) {
                return result;
            }

            // 落盘到 <demandDir>/code/relevant-rules.json（与 design-tdd-plan.md 同目录）
            const codeDir = path.dirname(context.fixedPaths.designTddPlanPath);
            const relevantRulesPath = path.join(codeDir, 'relevant-rules.json');
            const writeRes = this.relevantRulesBuilderService.writePayload(relevantRulesPath, result.payload);
            // 把内存 payload 透出去，下游 business-facts 渲染 selfAudit 直接复用，避免二次读盘
            return Object.assign({}, writeRes, { _inMemoryPayload: result.payload });
        } catch (error) {
            return {
                ok: false,
                errorCode: 'RELEVANT_RULES_BUILD_UNEXPECTED',
                message: error.message
            };
        }
    }

    _buildStructuredPlan({ context, modules, htmlContract, placementContracts, frameworkBucket, projectPath = '' }) {
        const filePlan = [];
        const htmlPages = [];
        const serviceContractSeeds = [];
        const actionContractSeeds = [];
        const modulePlans = [];
        const intentLocks = [];
        const intentLockInputs = [];
        const surfaceIdentityContracts = new Map();
        const paths = context.loadedArtifacts.navigationContract.paths || {};
        const workingModules = this._canonicalizeCarriedQueryModules(modules);

        // 全局文件去重映射：同一 (fileKind, resolvedPath) 在多模块出现时，
        // 只让第一个模块（owner）真正物化骨架，其余模块在 intentLock 里把该文件标记为
        // "consumed"（已有/由 owner 物化），不重复进 filePlan 也不重复推骨架。
        // 故事线：设计阶段经常把同一聚合根（同 entityName+bizModule）按用例拆成多个模块
        // （新增/编辑/列表/详情），但后端 5 件套和前端页面是聚合级共享物理文件。
        // 不去重 → 物化时撞 DESIGN_TDD_SKELETON_TARGET_ALREADY_EXISTS 死循环。
        // 去重逻辑是 Builder-owned 衍生事实（"同路径同种类只能落一份"是文件系统硬约束），
        // LLM 视野无感——它看到 plan 里每个文件恰好一份。
        const fileOwnerByKey = new Map();
        const fileOwnerEntryByKey = new Map();
        // dedup 防撞辅助索引：已写入 owner 的模块业务身份（entityName + bizModule + domain）。
        // 合法重叠：同聚合根（同 entityName + bizModule）的多个模块共享后端 5 件套和前端页面。
        // 非法撞车：两个不同 entity 解析到同一 path（说明上游 builder 算错了 bizModule/path），
        // 应该直接 fail-fast 让用户回头修设计，不能默默把后到 entity 全部降级成 consumer
        // → 整模块 0 owner 文件物化。
        const ownerIdentityByModule = new Map();
        const assertNoCrossEntityPathCollision = (existingOwnerModuleId, currentModuleId, currentIdentity, dedupKey) => {
            if (!existingOwnerModuleId || existingOwnerModuleId === currentModuleId) return null;
            const existingIdentity = ownerIdentityByModule.get(existingOwnerModuleId);
            if (!existingIdentity) return null;
            const sameEntity = (existingIdentity.entityName || '') === (currentIdentity.entityName || '')
                && (existingIdentity.bizModule || '') === (currentIdentity.bizModule || '')
                && (existingIdentity.domain || '') === (currentIdentity.domain || '');
            if (sameEntity) return null;
            return this._blocked('DESIGN_TDD_PLAN_PATH_COLLISION_CROSS_ENTITY',
                `模块 ${currentModuleId} 与模块 ${existingOwnerModuleId} 解析到同一物理路径却归属不同业务 entity，禁止默默降级。`,
                {
                    moduleId: currentModuleId,
                    conflictWithModuleId: existingOwnerModuleId,
                    dedupKey,
                    currentIdentity,
                    existingIdentity,
                    repairHint: '回到 epoint-requirement-design 修 设计文档.json：检查 businessEntities[].entityKey/domain/linkedTable.tableFeatureName 是否让两个独立 entity 派生出同一目录或文件名。'
                });
        };

        // 前端 HtmlPage CRUD 补全（pre-pass）：扫所有模块 htmlPages，按 bizModule 聚合；
        // 任一聚合出现 subType=list → ensure add/edit/detail 也存在，缺的补到 list 所在模块。
        // 触发条件保守："没出现 list" 不补（管理端配置页常见单 edit 形态，不应误补）。
        // 这是 Builder-owned 衍生事实——管理端 list 页天然带"新增/编辑/查看"按钮，
        // 缺 add/edit/detail 跑不通，是规则模板的 EUI MiniUI 硬约定，不是 LLM 业务决策。
        this._autoCompleteCrudHtmlPages(workingModules);
        this._autoCompleteWorkflowProcessSeeds(workingModules, {
            projectPath,
            paths,
            placementContracts,
            htmlContract
        });
        this._autoCompleteActionSeedsFromHtmlPages(workingModules);

        for (const module of workingModules) {
            const handoff = this._getHandoff(module);
            if (handoff.excludedFromCoding === true || module.excludedFromCoding === true) {
                continue;
            }
            const moduleId = this._moduleId(module);
            const objectKey = this._pick(handoff.objectKey, module.objectKey, module.entityKey);
            const carriedByModuleId = this._pick(handoff.carriedByModuleId, module.carriedByModuleId);
            const bizModule = this._pick(handoff.bizModule, module.bizModule);
            const businessObject = this._pick(module.businessObject, handoff.businessObject);
            const aggregateRoot = this._pick(module.aggregateRoot, handoff.aggregateRoot);
            const entityName = this._pick(handoff.entityName, module.entityName, handoff.EntityName);
            const featureName = this._pick(handoff.featureName, module.featureName, entityName, businessObject);
            const domain = this._pick(handoff.domain, module.domain);
            const pageName = this._pick(handoff.pageName, handoff.pagename, module.pageName, module.pagename);
            const surfaceIdentity = String(this._pick(handoff.surfaceIdentity, module.surfaceIdentity) || '').trim();
            const constructionSceneKey = this._pick(handoff.constructionSceneKey, module.constructionSceneKey);
            const practiceSceneKeys = this._normalizeStringList(
                handoff.practiceSceneKeys,
                module.practiceSceneKeys
            );
            const pageComposition = handoff.pageComposition && typeof handoff.pageComposition === 'object'
                ? JSON.parse(JSON.stringify(handoff.pageComposition))
                : (module.pageComposition && typeof module.pageComposition === 'object'
                    ? JSON.parse(JSON.stringify(module.pageComposition))
                    : null);
            const interactionCarrier = handoff.interactionCarrier || module.interactionCarrier || null;
            const restContract = this._normalizeRestContract(handoff.restContract || module.restContract);
            const statisticsContracts = this._normalizeStatisticsContracts(
                handoff.statisticsContracts || module.statisticsContracts,
                handoff.statisticsContract || module.statisticsContract
            );
            const statisticsContract = statisticsContracts.length === 1
                ? this._stripStatisticsStoryRef(statisticsContracts[0])
                : null;
            const workflowContracts = this._normalizeWorkflowContracts(
                handoff.workflowContracts || module.workflowContracts,
                handoff.workflowContract || module.workflowContract
            );
            const workflowContract = workflowContracts.length === 1
                ? this._stripWorkflowStoryRef(workflowContracts[0])
                : null;
            const acceptanceRefs = this._acceptanceRefs(module);
            const redIntent = handoff.redIntent || this._firstAcceptanceText(module, 'exception');
            const greenIntent = handoff.greenIntent || this._firstAcceptanceText(module, 'happyPath');
            const guardIntent = handoff.guardIntent || this._firstAcceptanceText(module, 'boundary') || (Array.isArray(module.invariants) ? module.invariants.join('；') : '');

            if (surfaceIdentity) {
                const surfaceContract = JSON.stringify({
                    objectKey: String(objectKey || '').trim(),
                    entityName: String(entityName || '').trim(),
                    bizModule: String(bizModule || '').trim(),
                    domain: String(domain || '').trim(),
                    pageName: String(pageName || '').trim(),
                    constructionSceneKey: String(constructionSceneKey || '').trim()
                });
                const existingSurface = surfaceIdentityContracts.get(surfaceIdentity);
                if (existingSurface && existingSurface.contract !== surfaceContract) {
                    return this._blocked(
                        'DESIGN_TDD_SURFACE_IDENTITY_CONFLICT',
                        `页面身份 ${surfaceIdentity} 被多个不等价合同声明，禁止合并。`,
                        {
                            surfaceIdentity,
                            firstModuleId: existingSurface.moduleId,
                            conflictModuleId: moduleId,
                            firstContract: JSON.parse(existingSurface.contract),
                            conflictContract: JSON.parse(surfaceContract),
                            allowedNextActions: ['repair_design_surface_identity_then_rerun_design_tdd_build_plan']
                        }
                    );
                }
                if (!existingSurface) surfaceIdentityContracts.set(surfaceIdentity, { moduleId, contract: surfaceContract });
            }

            const moduleFiles = [];
            const normalizedFileSeeds = this._ensureServiceOnlyFileSeeds(
                this._normalizeFileSeeds(handoff, {
                    constructionSceneKey,
                    carriedByModuleId,
                    module,
                    designDocument: context.loadedArtifacts.designDocument,
                    projectPath
                }),
                {
                    constructionSceneKey,
                    carriedByModuleId,
                    moduleId,
                    statisticsContracts
                }
            );
            for (const fileSeed of normalizedFileSeeds) {
                const resolved = this._resolveFileSeed(fileSeed, {
                    paths,
                    placementContracts,
                    bizModule,
                    domain,
                    entityName,
                    featureName,
                    operationName: this._pick(fileSeed.operationName, handoff.operationName, module.operationName),
                    pageName: this._pick(fileSeed.pageName, fileSeed.pagename, pageName),
                    moduleId
                });
                if (!resolved.ok) return resolved;
                const file = {
                    ...resolved.file,
                    ...(module.storyId ? {
                        storyIds: this._normalizeStringList(resolved.file.storyIds, [module.storyId])
                            .map(value => value.toUpperCase())
                    } : {})
                };
                const dedupKey = `${file.fileKind}:${file.resolvedPath}`;
                const existingOwner = fileOwnerByKey.get(dedupKey);
                const currentIdentity = { entityName, bizModule, domain };
                if (existingOwner) {
                    const collision = assertNoCrossEntityPathCollision(existingOwner, moduleId, currentIdentity, dedupKey);
                    if (collision) return collision;
                    // 文件已被其他模块声明为 owner，本模块只是消费方
                    moduleFiles.push({ ...file, ownerModuleId: existingOwner, role: 'consumer' });
                    const ownerEntry = fileOwnerEntryByKey.get(dedupKey);
                    if (ownerEntry) ownerEntry.storyIds = this._normalizeStringList(ownerEntry.storyIds, file.storyIds).map(value => value.toUpperCase());
                } else {
                    fileOwnerByKey.set(dedupKey, moduleId);
                    if (!ownerIdentityByModule.has(moduleId)) ownerIdentityByModule.set(moduleId, currentIdentity);
                    const ownedFile = { ...file, ownerModuleId: moduleId, role: 'owner' };
                    fileOwnerEntryByKey.set(dedupKey, ownedFile);
                    filePlan.push(ownedFile);
                    moduleFiles.push(ownedFile);
                }
            }

            const moduleHtmlPages = [];
            for (const seed of this._normalizeHtmlSeeds(handoff)) {
                const pageName = this._pick(seed.pageName, seed.pagename, handoff.pageName, handoff.pagename, module.pageName, module.pagename);
                const resolved = this._resolveHtmlPage(htmlContract, {
                    moduleId,
                    subType: seed.subType,
                    bizModule: this._pick(seed.bizModule, bizModule),
                    pageName,
                    evidenceRef: seed.evidenceRef || moduleId,
                    ...(seed.queryOnly === true ? { queryOnly: true } : {}),
                    ...(seed.statisticsOnly === true ? { statisticsOnly: true } : {}),
                    ...(seed.sectionKey ? { sectionKey: seed.sectionKey } : {}),
                    ...(seed.targetPageRole ? { targetPageRole: seed.targetPageRole } : {}),
                    ...(seed.interactionCarrier ? { interactionCarrier: seed.interactionCarrier } : {}),
                    ...(seed.objectKey ? { objectKey: seed.objectKey } : {}),
                    ...(Array.isArray(seed.storyIds) ? { storyIds: seed.storyIds.slice() } : {}),
                    ...(seed.projectionSource ? { projectionSource: seed.projectionSource } : {}),
                    ...(seed.managedProjection === true ? { managedProjection: true } : {})
                });
                if (!resolved.ok) return resolved;
                const resolvedFile = {
                    ...resolved.file,
                    ...(module.storyId ? {
                        storyIds: this._normalizeStringList(resolved.file.storyIds, [module.storyId])
                            .map(value => value.toUpperCase())
                    } : {})
                };
                const resolvedPage = {
                    ...resolved.page,
                    ...(module.storyId ? {
                        storyIds: this._normalizeStringList(resolved.page.storyIds, [module.storyId])
                            .map(value => value.toUpperCase())
                    } : {})
                };
                const dedupKey = `${resolvedFile.fileKind}:${resolvedFile.resolvedPath}`;
                const existingOwner = fileOwnerByKey.get(dedupKey);
                const currentIdentity = { entityName, bizModule, domain };
                if (existingOwner) {
                    const collision = assertNoCrossEntityPathCollision(existingOwner, moduleId, currentIdentity, dedupKey);
                    if (collision) return collision;
                    // 同一 HtmlPage（如两个模块都要 list/place）只让 owner 物化
                    moduleFiles.push({ ...resolvedFile, ownerModuleId: existingOwner, role: 'consumer' });
                    moduleHtmlPages.push({ ...resolvedPage, ownerModuleId: existingOwner, role: 'consumer' });
                    const ownerEntry = fileOwnerEntryByKey.get(dedupKey);
                    if (ownerEntry) ownerEntry.storyIds = this._normalizeStringList(ownerEntry.storyIds, resolvedFile.storyIds).map(value => value.toUpperCase());
                } else {
                    fileOwnerByKey.set(dedupKey, moduleId);
                    if (!ownerIdentityByModule.has(moduleId)) ownerIdentityByModule.set(moduleId, currentIdentity);
                    const ownedFile = { ...resolvedFile, ownerModuleId: moduleId, role: 'owner' };
                    fileOwnerEntryByKey.set(dedupKey, ownedFile);
                    const ownedPage = { ...resolvedPage, ownerModuleId: moduleId, role: 'owner' };
                    htmlPages.push(ownedPage);
                    filePlan.push(ownedFile);
                    moduleFiles.push(ownedFile);
                    moduleHtmlPages.push(ownedPage);
                }
            }

            for (const seed of this._normalizeContractSeeds(handoff.serviceContractSeeds || handoff.methodSeeds || [])) {
                const normalizedSeed = {
                    moduleId,
                    sourceModuleId: moduleId,
                    sourceStoryId: String(seed.sourceStoryId || module.storyId || module.sourceStoryId || '').trim().toUpperCase(),
                    ownerService: seed.ownerService || '',
                    methodName: seed.methodName || '',
                    actionKey: seed.actionKey || '',
                    purpose: seed.purpose || seed.description || '',
                    tddIntent: seed.tddIntent || '',
                    sourceType: seed.sourceType || '',
                    ...(seed.statisticsTitle ? { statisticsTitle: String(seed.statisticsTitle).trim() } : {}),
                    evidenceRef: seed.evidenceRef || acceptanceRefs[0] || moduleId,
                    plannedConsumer: seed.plannedConsumer || ''
                };
                serviceContractSeeds.push(normalizedSeed);
            }
            for (const seed of this._normalizeContractSeeds(handoff.actionContractSeeds || [])) {
                const normalizedSeed = {
                    moduleId,
                    sourceModuleId: moduleId,
                    sourceStoryId: String(seed.sourceStoryId || module.storyId || module.sourceStoryId || '').trim().toUpperCase(),
                    actionKey: seed.actionKey || seed.methodName || '',
                    purpose: seed.purpose || seed.description || '',
                    tddIntent: seed.tddIntent || '',
                    sourceType: seed.sourceType || '',
                    ...(seed.statisticsTitle ? { statisticsTitle: String(seed.statisticsTitle).trim() } : {}),
                    evidenceRef: seed.evidenceRef || acceptanceRefs[0] || moduleId,
                    plannedConsumer: seed.plannedConsumer || ''
                };
                actionContractSeeds.push(normalizedSeed);
            }

            const modulePlan = {
                moduleId,
                objectKey,
                storyId: String(module.storyId || module.sourceStoryId || '').trim().toUpperCase(),
                carriedByModuleId,
                moduleName: module.moduleName || '',
                userStory: module.userStory || module.description || '',
                businessObject,
                aggregateRoot,
                bizModule,
                domain,
                entityName,
                featureName,
                operationName: this._pick(handoff.operationName, module.operationName),
                pageName,
                pagename: pageName,
                ...(surfaceIdentity ? { surfaceIdentity } : {}),
                constructionSceneKey,
                practiceSceneKeys,
                ...(statisticsContract ? { statisticsContract } : {}),
                ...(statisticsContracts.length > 0 ? { statisticsContracts } : {}),
                ...(workflowContract ? { workflowContract } : {}),
                ...(workflowContracts.length > 0 ? { workflowContracts } : {}),
                ...(interactionCarrier ? { interactionCarrier } : {}),
                ...(pageComposition ? { pageComposition } : {}),
                ...(restContract ? { restContract } : {}),
                acceptanceRefs,
                redIntent,
                greenIntent,
                guardIntent,
                files: moduleFiles.map(item => item.resolvedPath),
                htmlPages: moduleHtmlPages.map(item => item.resolvedPath)
            };
            modulePlans.push({
                ...modulePlan
            });
            intentLockInputs.push({
                modulePlan,
                moduleFiles,
                navigationContractSourcePath: context.loadedArtifacts.navigationContractSourcePath,
                designDocumentPath: context.fixedPaths.designDocumentPath
            });
        }

        const serviceSeedProjection = this._projectServiceContractSeedOwnership({
            serviceContractSeeds,
            modulePlans,
            filePlan
        });
        if (!serviceSeedProjection.ok) return serviceSeedProjection;
        serviceContractSeeds.splice(0, serviceContractSeeds.length, ...serviceSeedProjection.seeds);
        if (Array.isArray(serviceSeedProjection.filePlan)) {
            filePlan.splice(0, filePlan.length, ...serviceSeedProjection.filePlan);
        }

        for (const input of intentLockInputs) {
            intentLocks.push(this._buildIntentLock({
                ...input,
                serviceSeeds: serviceContractSeeds.filter(seed => seed.moduleId === input.modulePlan.moduleId),
                actionSeeds: actionContractSeeds.filter(seed => seed.moduleId === input.modulePlan.moduleId)
            }));
        }

        return {
            ok: true,
            modulePlans,
            intentLocks,
            filePlan,
            htmlPages,
            serviceContractSeeds,
            actionContractSeeds
        };
    }

    _projectServiceContractSeedOwnership({ serviceContractSeeds = [], modulePlans = [], filePlan = [] } = {}) {
        const modulesById = new Map((Array.isArray(modulePlans) ? modulePlans : [])
            .map(modulePlan => [String(modulePlan && modulePlan.moduleId || '').trim(), modulePlan])
            .filter(([moduleId]) => moduleId));
        const serviceKinds = ['ServiceApi', 'ServiceInternal', 'ServiceImpl'];
        const projected = [];
        const carriedServiceSourceModuleIds = new Set();

        for (const rawSeed of (Array.isArray(serviceContractSeeds) ? serviceContractSeeds : [])) {
            const seed = rawSeed && typeof rawSeed === 'object' ? rawSeed : {};
            const sourceType = String(seed.sourceType || '').trim();
            const sourceModuleId = String(seed.sourceModuleId || seed.moduleId || '').trim();
            const sourceModule = modulesById.get(sourceModuleId) || {};
            const carrierModuleId = String(
                seed.carriedByModuleId || sourceModule.carriedByModuleId || ''
            ).trim();
            const isServiceOnlyProjection = sourceType === 'statisticsContract'
                || seed.serviceOnly === true
                || seed.noEntity === true
                || sourceModule.serviceOnly === true
                || sourceModule.noEntity === true;
            if (!isServiceOnlyProjection) {
                projected.push(seed);
                continue;
            }

            const ownerModuleId = carrierModuleId || sourceModuleId;
            if (carrierModuleId) carriedServiceSourceModuleIds.add(sourceModuleId);
            const filesByKind = new Map(serviceKinds.map(fileKind => [
                fileKind,
                (Array.isArray(filePlan) ? filePlan : []).filter(file =>
                    String(file && file.moduleId || '').trim() === ownerModuleId
                    && String(file && file.fileKind || '').trim() === fileKind
                )
            ]));
            const invalidKinds = serviceKinds.filter(fileKind => (filesByKind.get(fileKind) || []).length !== 1);
            if (invalidKinds.length > 0) {
                const projectionErrorCode = sourceType === 'statisticsContract'
                    ? 'DESIGN_TDD_STATISTICS_CARRIER_SERVICE_PROJECTION_MISSING'
                    : 'DESIGN_TDD_SERVICE_ONLY_PROJECTION_MISSING';
                return this._blocked(
                    projectionErrorCode,
                    carrierModuleId
                        ? `模块 ${sourceModuleId || '(unknown)'} 无法机械定位 carriedByModuleId 的唯一 Service 三层文件。`
                        : `模块 ${sourceModuleId || '(unknown)'} 没有本模块唯一的 Service 三层文件，无法生成只读 Service。`,
                    {
                        source: 'design_tdd_build_plan',
                        defectOwner: 'Builder',
                        sourceModuleId,
                        carriedByModuleId: carrierModuleId,
                        ownerModuleId,
                        invalidFileKinds: invalidKinds,
                        allowedNextActions: ['fix_builder_projection_then_rerun_design_tdd_build_plan']
                    }
                );
            }

            const serviceApiFile = filesByKind.get('ServiceApi')[0];
            const serviceApiPath = String(serviceApiFile.resolvedPath || '').trim();
            const ownerService = (serviceApiPath.split(/[\\/]/u).pop() || '').replace(/\.java$/iu, '');
            if (!ownerService) {
                return this._blocked(
                    sourceType === 'statisticsContract'
                        ? 'DESIGN_TDD_STATISTICS_CARRIER_SERVICE_PROJECTION_MISSING'
                        : 'DESIGN_TDD_SERVICE_ONLY_PROJECTION_MISSING',
                    `模块 ${sourceModuleId} 无法从承载模块 ServiceApi 最终文件身份派生 ownerService。`,
                    {
                        source: 'design_tdd_build_plan',
                        defectOwner: 'Builder',
                        sourceModuleId,
                        carriedByModuleId: carrierModuleId,
                        ownerModuleId,
                        serviceApiPath,
                        allowedNextActions: ['fix_builder_projection_then_rerun_design_tdd_build_plan']
                    }
                );
            }

            const sourceStoryId = String(seed.sourceStoryId || sourceModule.storyId || '').trim().toUpperCase();
            if (sourceStoryId) {
                for (const fileKind of serviceKinds) {
                    const file = filesByKind.get(fileKind)[0];
                    file.storyIds = this._normalizeStringList(file.storyIds, [sourceStoryId])
                        .map(storyId => storyId.toUpperCase());
                }
            }
            projected.push({
                ...seed,
                moduleId: ownerModuleId,
                sourceModuleId,
                sourceStoryId,
                ownerService
            });
        }

        // 统计/查询模块的 Service 三层只是旧设计遗留的“局部承载草图”，
        // 最终物理承载已经由 carriedByModuleId 的 Service 三层承担。
        // 在唯一 fileSet 阶段删除这组幽灵文件，避免新投影重新生成 I*StatisticsService。
        const filteredFilePlan = (Array.isArray(filePlan) ? filePlan : []).filter(file => {
            const sourceModuleId = String(file && file.moduleId || '').trim();
            const fileKind = String(file && file.fileKind || '').trim();
            return !(carriedServiceSourceModuleIds.has(sourceModuleId)
                && ['ServiceApi', 'ServiceInternal', 'ServiceImpl'].includes(fileKind)
                && String(file && file.projectionSource || '').trim() === 'statisticsContract');
        });
        return { ok: true, seeds: projected, filePlan: filteredFilePlan };
    }

    _resolveHtmlPage(contract = {}, seed = {}) {
        const subType = String(seed.subType || '').trim().toLowerCase();
        const bizModule = String(seed.bizModule || '').trim();
        const pageName = String(seed.pageName || '').trim();
        if (!contract.relativeDirPattern || !contract.fileNamePattern) {
            return this._blocked('DESIGN_TDD_PLAN_HTML_CONTRACT_MISSING', '工程导航契约缺少 HtmlPage 放置合同。');
        }
        if (!subType) return this._blocked('DESIGN_TDD_PLAN_HTML_SUBTYPE_MISSING', `模块 ${seed.moduleId} 缺少 HtmlPage subType。`);
        if (!bizModule) return this._blocked('DESIGN_TDD_PLAN_HTML_BIZ_MODULE_MISSING', `模块 ${seed.moduleId} 缺少 HtmlPage bizModule。`);
        if (!pageName) return this._blocked('DESIGN_TDD_PLAN_HTML_PAGE_NAME_MISSING', `模块 ${seed.moduleId} 缺少 HtmlPage pageName。`);
        if (/[\\/]/u.test(bizModule) || /[\\/]/u.test(pageName)) {
            return this._blocked('DESIGN_TDD_PLAN_HTML_NAME_UNSAFE', `HtmlPage bizModule/pageName 不得包含路径分隔符：${seed.moduleId}`);
        }

        const variant = contract.variants && contract.variants[subType] ? contract.variants[subType] : {};
        const listVariant = contract.variants && contract.variants.list ? contract.variants.list : {};
        let fileNamePattern = String(variant.fileNamePattern || contract.fileNamePattern || listVariant.fileNamePattern || '').trim();
        if (fileNamePattern && !variant.fileNamePattern && !/\{SubType\}|\{subType\}/u.test(fileNamePattern)) {
            fileNamePattern = fileNamePattern
                .replace(/(list|add|edit|detail|workflow|mylist)(\.html?)$/iu, '{subType}$2')
                .replace(/(\{(?:pageName|pagename|PageName)\})(\.html?)$/u, '$1{subType}$2');
        }
        const resolvedFileName = this._applyTemplate(fileNamePattern, {
            pagename: pageName,
            pageName,
            SubType: subType,
            subType
        });
        const resolvedDir = this._applyTemplate(contract.relativeDirPattern, { bizModule });
        if (this._hasUnresolvedPlaceholder(resolvedFileName) || this._hasUnresolvedPlaceholder(resolvedDir)) {
            return this._blocked('DESIGN_TDD_PLAN_HTML_TEMPLATE_UNRESOLVED',
                `HtmlPage 模板未完全解析：${contract.relativeDirPattern} / ${fileNamePattern}`,
                { moduleId: seed.moduleId, bizModule, pageName, subType });
        }
        const resolvedPath = this._normalizeSlash(path.posix.join(resolvedDir.replace(/\\/g, '/'), resolvedFileName));
        const contractSource = contract.contractSource || {};
        const resolvedSectionKey = this._defaultSectionKeyForFileKind('HtmlPage', { ...seed, subType });
        const resolvedTargetPageRole = String(
            seed.targetPageRole || (subType === 'workflowdetail' ? 'workflow_detail' : '')
        ).trim();
        const page = {
            moduleId: seed.moduleId,
            subType,
            bizModule,
            pageName,
            pagename: pageName,
            fileNamePattern,
            relativeDirPattern: contract.relativeDirPattern,
            resolvedFileName,
            resolvedPath,
            contractSource,
            evidenceRef: seed.evidenceRef || seed.moduleId,
            ...(seed.queryOnly === true ? { queryOnly: true } : {}),
            ...(seed.statisticsOnly === true ? { statisticsOnly: true } : {}),
            ...(resolvedSectionKey ? { sectionKey: resolvedSectionKey } : {}),
            ...(resolvedTargetPageRole ? { targetPageRole: resolvedTargetPageRole } : {}),
            ...(seed.interactionCarrier ? { interactionCarrier: seed.interactionCarrier } : {})
        };
        return {
            ok: true,
            page,
            file: {
                moduleId: seed.moduleId,
                fileKind: 'HtmlPage',
                operation: 'create',
                resolvedPath,
                contractSource,
                evidenceRef: seed.evidenceRef || seed.moduleId,
                // subType 透传给 filePlan/dedup/plan.json，让 nextActionCard 派生 sectionKey
                subType,
                ...(seed.queryOnly === true ? { queryOnly: true } : {}),
                ...(seed.statisticsOnly === true ? { statisticsOnly: true } : {}),
                ...(resolvedSectionKey ? { sectionKey: resolvedSectionKey } : {}),
                ...(resolvedTargetPageRole ? { targetPageRole: resolvedTargetPageRole } : {}),
                ...(seed.interactionCarrier ? { interactionCarrier: seed.interactionCarrier } : {}),
                ...(seed.objectKey ? { objectKey: seed.objectKey } : {}),
                ...(Array.isArray(seed.storyIds) ? { storyIds: seed.storyIds.slice() } : {}),
                ...(seed.projectionSource ? { projectionSource: seed.projectionSource } : {}),
                ...(seed.managedProjection === true ? { managedProjection: true } : {})
            }
        };
    }

    _resolveFileSeed(seed = {}, context = {}) {
        const fileKind = String(seed.fileKind || '').trim();
        const operation = String(seed.operation || 'create').trim();
        const rawSubType = String(seed.subType || '').trim().toLowerCase();
        // 兼容旧设计产物：Action fileSeed 未写 subType 时，历史语义就是 ListAction。
        // 组合合同需要显式 split by subType，所以在 Builder 内部统一归一化为 list。
        const subType = rawSubType || (fileKind === 'Action' ? 'list' : '');
        const paths = context.paths || {};
        const placementContracts = context.placementContracts || {};
        const placement = placementContracts[fileKind] || {};
        const key = this._pathKeyForFileKind(fileKind);
        const template = String(seed.relativeDirPattern || placement.relativeDirPattern || (key ? paths[key] : '') || '').trim();
        if (!fileKind) return this._blocked('DESIGN_TDD_PLAN_FILE_KIND_MISSING', `模块 ${context.moduleId} 的 fileSeeds 缺少 fileKind。`);
        if (!template && !seed.resolvedPath) {
            return this._blocked('DESIGN_TDD_PLAN_FILE_TEMPLATE_MISSING', `工程导航契约缺少 ${fileKind} 路径模板。`, {
                moduleId: context.moduleId,
                fileKind
            });
        }
        // Action / HtmlPage subType（list/add/edit/detail）走 variants 派生独立文件名：
        //   Action:    Gxh{EntityName}{List|Add|Edit|Detail}Action.java
        //   HtmlPage:  gxh{pagename}{list|add|edit|detail}.html
        // Epoint 公司硬约定，每个 SubType 对应一个独立物理文件。
        // 顶层 fileNamePattern 含 {SubType} 占位符走通用模板时 _resolveFileNameFromPlacement
        // 因 SubType 值未填会判 missing → 返回空 → 抛 FILE_NAME_CONTRACT_MISSING；
        // 必须切到 variants（已不含 {SubType} 占位符）渲染。
        const variantPlacement = this._placementForFileSubType(fileKind, subType, placement);
        // resolvedPath 是上游已经确认的物理事实。文件名只是它的最后一段，
        // 可以由 Builder 无歧义地计算，不应再要求 LLM 或 Coder 重填。
        const resolvedPathFileName = String(seed.resolvedPath || '').trim()
            .replace(/\\/g, '/').split('/').pop() || '';
        const fileName = seed.fileName
            || resolvedPathFileName
            || this._resolveFileNameFromPlacement(fileKind, variantPlacement, context);
        if (!fileName) {
            return this._blocked('DESIGN_TDD_PLAN_FILE_NAME_CONTRACT_MISSING',
                `模块 ${context.moduleId} 的 ${fileKind} 缺少文件名合同或显式 fileName，禁止由 Coder 按 Java 习惯猜文件名。`,
                { moduleId: context.moduleId, fileKind });
        }
        const missingTemplateVars = this._missingTemplateVariables(template, {
            domain: seed.domain || context.domain,
            bizModule: seed.bizModule || context.bizModule
        });
        if (missingTemplateVars.length > 0 && !seed.resolvedPath) {
            return this._blocked('DESIGN_TDD_PLAN_FILE_TEMPLATE_VARIABLE_MISSING',
                `模块 ${context.moduleId} 的 ${fileKind} 缺少路径模板变量：${missingTemplateVars.join(', ')}`,
                { moduleId: context.moduleId, fileKind, template });
        }
        const resolvedDir = seed.resolvedDir || this._applyTemplate(template, {
            domain: seed.domain || context.domain,
            bizModule: seed.bizModule || context.bizModule
        });
        const resolvedPath = seed.resolvedPath || this._normalizeSlash(path.posix.join(resolvedDir.replace(/\\/g, '/'), fileName));
        if (this._hasUnresolvedPlaceholder(resolvedPath)) {
            return this._blocked('DESIGN_TDD_PLAN_FILE_TEMPLATE_UNRESOLVED',
                `文件路径模板未完全解析：${resolvedPath}`,
                { moduleId: context.moduleId, fileKind });
        }
        return {
            ok: true,
            file: {
                moduleId: context.moduleId,
                fileKind,
                operation,
                ...(subType ? { subType } : {}),
                ...(seed.queryOnly === true ? { queryOnly: true } : {}),
                ...(seed.statisticsOnly === true ? { statisticsOnly: true } : {}),
                ...(seed.serviceOnly === true ? { serviceOnly: true } : {}),
                ...(seed.noEntity === true ? { noEntity: true } : {}),
                ...(fileKind === 'Action'
                    ? { sectionKey: this._defaultSectionKeyForFileKind(fileKind, { ...seed, subType }) }
                    : (seed.sectionKey ? { sectionKey: seed.sectionKey } : {})),
                ...(seed.targetPageRole ? { targetPageRole: seed.targetPageRole } : {}),
                ...(seed.interactionCarrier ? { interactionCarrier: seed.interactionCarrier } : {}),
                ...(seed.objectKey ? { objectKey: seed.objectKey } : {}),
                ...(Array.isArray(seed.storyIds) ? { storyIds: seed.storyIds.slice() } : {}),
                ...(seed.projectionSource ? { projectionSource: seed.projectionSource } : {}),
                ...(seed.managedProjection === true ? { managedProjection: true } : {}),
                resolvedPath,
                contractSource: seed.contractSource || (placement.contractSource || 'navigationContract.rulePlacementContract'),
                evidenceRef: seed.evidenceRef || context.moduleId
            }
        };
    }

    _placementForFileSubType(fileKind = '', subType = '', placement = {}) {
        const kind = String(fileKind || '').trim();
        const sub = String(subType || '').trim().toLowerCase();
        if ((kind !== 'Action' && kind !== 'HtmlPage') || !sub) return placement;
        const variant = placement && placement.variants && placement.variants[sub] ? placement.variants[sub] : null;
        if (variant && String(variant.fileNamePattern || '').trim()) {
            return { ...placement, fileNamePattern: String(variant.fileNamePattern || '').trim() };
        }
        const listVariant = placement && placement.variants && placement.variants.list ? placement.variants.list : {};
        const basePattern = String(placement && (placement.fileNamePattern || listVariant.fileNamePattern) || '').trim();
        if (!basePattern) return placement;
        if (kind === 'Action') {
            const suffix = this._subTypeLiteral(sub);
            const generic = /\{SubType\}/u.test(basePattern)
                ? basePattern
                : basePattern.replace(/(List|Add|Edit|Detail)(Action\.java)$/u, '{SubType}$2');
            return {
                ...placement,
                fileNamePattern: generic.replace(/\{SubType\}/gu, suffix)
            };
        }
        const suffix = sub;
        const generic = /\{SubType\}/u.test(basePattern)
            ? basePattern
            : basePattern
                .replace(/(list|add|edit|detail)(\.html?)$/iu, '{SubType}$2')
                .replace(/(\{(?:pageName|pagename|PageName)\})(\.html?)$/u, '$1{SubType}$2');
        return {
            ...placement,
            fileNamePattern: generic.replace(/\{SubType\}/gu, suffix)
        };
    }

    _resolveFileNameFromPlacement(fileKind = '', placement = {}, context = {}) {
        // ServiceInternal 命名 Builder 兜底：rule 模板硬性约定文件名 Gxh{EntityName}Service.java
        // （同 ServiceImpl 一个目录，去掉 Impl 后缀）。当 navigationContract.rulePlacementContract
        // 没显式给 ServiceInternal 条目时（旧 scan 没枚举该层），Builder 直接按规则模板派生，
        // 不让 Builder 因"占位符不全"返回空，导致 Builder 自动补全的 4 件套断在文件名上。
        if (fileKind === 'ServiceInternal' && !String(placement.fileNamePattern || '').trim()) {
            const entityName = context.entityName || context.featureName || '';
            return entityName ? `Gxh${entityName}Service.java` : '';
        }
        const pattern = String(placement.fileNamePattern || '').trim();
        if (!pattern) return '';
        const values = {
            EntityName: context.entityName || '',
            FeatureName: context.featureName || context.entityName || '',
            OperationName: context.operationName || context.featureName || context.entityName || '',
            pagename: context.pageName || context.featureName || context.entityName || '',
            SubType: '',
            subType: ''
        };
        const missing = this._missingTemplateVariables(pattern, values);
        if (missing.length > 0) {
            return '';
        }
        return this._applyTemplate(pattern, values);
    }

    _renderMarkdown({ context, modulePlans, intentLocks, filePlan, htmlPages, existingUpdateTargets = [], serviceContractSeeds, actionContractSeeds, frameworkBucket }) {
        const lines = [];
        const demandName = (context.loadedArtifacts.designDocument.meta && (context.loadedArtifacts.designDocument.meta.demandName || context.loadedArtifacts.designDocument.meta.name)) || context.demandName;
        const versionBucket = this._extractVersionBucket(frameworkBucket);
        lines.push('# 设计 TDD 计划');
        lines.push('');
        lines.push('> 本文件由 `design_tdd_build_plan` 根据设计文档和工程导航契约生成。页面命名、路径模板和模块覆盖字段不得手写覆盖。');
        lines.push('');
        lines.push('## 1. 项目信息');
        lines.push('');
        lines.push('| 项目 | 值 |');
        lines.push('|---|---|');
        lines.push(`| 需求名称 | ${this._md(demandName)} |`);
        lines.push(`| 项目路径 | ${this._md(context.fixedPaths.demandDir.replace(/\\.ai-workspace.*/u, ''))} |`);
        lines.push(`| 版本桶 | ${this._md(versionBucket)} |`);
        lines.push(`| 工程导航契约 | ${this._md(context.loadedArtifacts.navigationContractSourcePath || context.fixedPaths.navigationCompactContractPath || context.fixedPaths.navigationContractPath)} |`);
        lines.push('');
        // §2 进度看板：Builder 渲染初始空看板（全 ⬜），后续由 design_tdd_skeleton_materialize
        // / LLM 在双写时通过 progressBoardService.markCell 动态打勾。看板包裹在 begin/end
        // 锚点之间，方便 markCell 用 str_replace 精确定位。
        lines.push(this.progressBoardService.renderInitialBoard(modulePlans));
        lines.push('');
        lines.push('## 3. 全局施工预览');
        lines.push('');
        lines.push('### 3.1 文件计划');
        lines.push('');
        lines.push('| 模块 | 操作 | 类型 | 路径 | 证据 |');
        lines.push('|---|---|---|---|---|');
        filePlan.forEach(item => {
            lines.push(`| ${this._md(item.moduleId)} | ${this._md(item.operation)} | ${this._md(item.fileKind)} | ${this._md(item.resolvedPath)} | ${this._md(item.evidenceRef)} |`);
        });
        lines.push('');
        if (existingUpdateTargets.length > 0) {
            lines.push('### 3.1.1 既有入口改造目标');
            lines.push('');
            lines.push('> 这些目标来自需求阶段 existingAdjustment.entryFiles，用于历史功能调整；它们不是新增 owner 文件，但必须进入后续 User Story 施工候选文件。');
            lines.push('');
            lines.push('| Story | 操作 | 类型 | 路径 | 来源 |');
            lines.push('|---|---|---|---|---|');
            existingUpdateTargets.forEach(item => {
                lines.push(`| ${this._md(item.storyId)} | ${this._md(item.operation)} | ${this._md(item.fileKind)} | ${this._md(item.resolvedPath)} | ${this._md(item.source)} |`);
            });
            lines.push('');
        }
        lines.push('### 3.2 HtmlPage 契约解析');
        lines.push('');
        lines.push('| 模块 | subType | bizModule | pagename | fileNamePattern | resolvedFileName | resolvedPath | contractSource |');
        lines.push('|---|---|---|---|---|---|---|---|');
        htmlPages.forEach(item => {
            const source = [item.contractSource.sourceRule, item.contractSource.usage].filter(Boolean).join('/');
            lines.push(`| ${this._md(item.moduleId)} | ${this._md(item.subType)} | ${this._md(item.bizModule)} | ${this._md(item.pagename)} | ${this._md(item.fileNamePattern)} | ${this._md(item.resolvedFileName)} | ${this._md(item.resolvedPath)} | ${this._md(source)} |`);
        });
        lines.push('');
        lines.push('### 3.3 模块覆盖计划');
        lines.push('');
        lines.push('| 模块 | 用户故事 | 业务对象 | 聚合根 | 实现目标 | 验证关注 | 关联代码 |');
        lines.push('|---|---|---|---|---|---|---|');
        modulePlans.forEach(item => {
            const files = item.carriedByModuleId
                ? `由 ${item.carriedByModuleId} 承载<br>${item.files.join('<br>')}`
                : item.files.join('<br>');
            lines.push(`| ${this._md(item.moduleId)} | ${this._md(item.userStory)} | ${this._md(item.businessObject)} | ${this._md(item.aggregateRoot)} | ${this._md(item.greenIntent || item.userStory)} | ${this._md(item.guardIntent)} | ${this._md(files)} |`);
        });
        lines.push('');
        lines.push('### 3.4 模块意图锁');
        lines.push('');
        lines.push('> 每个模块开工前只消费对应 lock。lock 外文件、页面、方法和业务范围都不是本轮事实。');
        lines.push('> **文件路径前的 [owner] 标识**表示本模块是该文件的物化责任人，必须调 design_tdd_skeleton_materialize；');
        lines.push('> **[consumer:MOD-XX] 标识**表示该文件由 MOD-XX 物化，本模块只消费、不重复物化（避免 TARGET_ALREADY_EXISTS）。');
        lines.push('');
        lines.push('| 模块 | lockId | 当前只做 | 允许文件 | 方法依据 | 禁止动作 |');
        lines.push('|---|---|---|---|---|---|');
        intentLocks.forEach(item => {
            const methodBasis = [
                item.methodPolicy.skeletonDefaultMethods,
                item.methodPolicy.businessExtensionMethods
            ].filter(Boolean).join('<br>');
            const filesText = item.allowedFiles.map(file => {
                const tag = file.role === 'consumer'
                    ? `[consumer:${file.ownerModuleId}]`
                    : '[owner]';
                return `${tag} ${file.resolvedPath}`;
            }).join('<br>');
            lines.push(`| ${this._md(item.moduleId)} | ${this._md(item.lockId)} | ${this._md(item.currentIntent)} | ${this._md(filesText)} | ${this._md(methodBasis)} | ${this._md(item.forbiddenActions.join('<br>'))} |`);
        });
        lines.push('');
        lines.push('### 3.5 Service 契约种子');
        lines.push('');
        lines.push('| 模块 | ownerService | methodName/actionKey | purpose | tddIntent | sourceType | evidenceRef | plannedConsumer |');
        lines.push('|---|---|---|---|---|---|---|---|');
        serviceContractSeeds.concat(actionContractSeeds).forEach(item => {
            lines.push(`| ${this._md(item.moduleId)} | ${this._md(item.ownerService || '')} | ${this._md(item.methodName || item.actionKey)} | ${this._md(item.purpose)} | ${this._md(item.tddIntent)} | ${this._md(item.sourceType)} | ${this._md(item.evidenceRef)} | ${this._md(item.plannedConsumer)} |`);
        });
        lines.push('');
        lines.push('## 4. 用户确认提示');
        lines.push('');
        lines.push('本计划由 Builder 根据已确认 Design 事实生成；编码阶段只读消费，不把它当成逐模块确认点。');
        lines.push('');
        return lines.join('\n');
    }

    _buildIntentLock({ modulePlan, moduleFiles, serviceSeeds, actionSeeds, navigationContractSourcePath, designDocumentPath }) {
        const seenFiles = new Set();
        const allowedFiles = [];
        moduleFiles.forEach(item => {
            const key = `${item.fileKind}:${item.resolvedPath}`;
            if (seenFiles.has(key)) return;
            seenFiles.add(key);
            // Builder 自动 dedup：同一物理文件被多模块声明时只让 owner 物化，
            // 其余模块只是 consumer。把 role / ownerModuleId 透到 intentLock，
            // 让 design_tdd_skeleton_materialize 入参检查 role==='owner' 才允许 create。
            allowedFiles.push({
                fileKind: item.fileKind,
                operation: item.operation,
                resolvedPath: item.resolvedPath,
                evidenceRef: item.evidenceRef,
                ...(item.subType ? { subType: item.subType } : {}),
                ...(item.targetPageRole ? { targetPageRole: item.targetPageRole } : {}),
                ...(item.interactionCarrier ? { interactionCarrier: item.interactionCarrier } : {}),
                role: item.role || 'owner',
                ownerModuleId: item.ownerModuleId || modulePlan.moduleId
            });
        });
        const businessExtensionSeeds = serviceSeeds.concat(actionSeeds).map(seed => ({
            methodName: seed.methodName || seed.actionKey,
            ownerService: seed.ownerService || '',
            purpose: seed.purpose,
            tddIntent: seed.tddIntent,
            sourceType: seed.sourceType,
            evidenceRef: seed.evidenceRef,
            plannedConsumer: seed.plannedConsumer
        }));
        return {
            lockId: `intent-lock:${modulePlan.moduleId}`,
            moduleId: modulePlan.moduleId,
            stepScope: 'module_implementation_scope',
            currentIntent: [
                modulePlan.businessObject ? `业务对象=${modulePlan.businessObject}` : '',
                modulePlan.aggregateRoot ? `聚合根=${modulePlan.aggregateRoot}` : '',
                modulePlan.greenIntent ? `实现目标=${modulePlan.greenIntent}` : modulePlan.userStory
            ].filter(Boolean).join('；'),
            businessContext: {
                userStory: modulePlan.userStory,
                ...(modulePlan.objectKey ? { objectKey: modulePlan.objectKey } : {}),
                businessObject: modulePlan.businessObject,
                aggregateRoot: modulePlan.aggregateRoot,
                bizModule: modulePlan.bizModule,
                domain: modulePlan.domain,
                entityName: modulePlan.entityName,
                featureName: modulePlan.featureName,
                pageName: modulePlan.pageName,
                pagename: modulePlan.pageName,
                constructionSceneKey: modulePlan.constructionSceneKey || '',
                practiceSceneKeys: Array.isArray(modulePlan.practiceSceneKeys) ? modulePlan.practiceSceneKeys : [],
                carriedByModuleId: modulePlan.carriedByModuleId || '',
                ...(modulePlan.pageComposition ? { pageComposition: modulePlan.pageComposition } : {}),
                ...(modulePlan.statisticsContract ? { statisticsContract: modulePlan.statisticsContract } : {}),
                ...(Array.isArray(modulePlan.statisticsContracts) && modulePlan.statisticsContracts.length > 0 ? { statisticsContracts: modulePlan.statisticsContracts } : {}),
                ...(modulePlan.interactionCarrier ? { interactionCarrier: modulePlan.interactionCarrier } : {}),
                ...(modulePlan.restContract ? { restContract: modulePlan.restContract } : {})
            },
            tddIntents: {
                red: modulePlan.redIntent,
                green: modulePlan.greenIntent,
                guard: modulePlan.guardIntent
            },
            allowedFacts: [
                { type: 'designDocument', ref: `${designDocumentPath}#modules.${modulePlan.moduleId}` },
                { type: 'navigationContract', ref: navigationContractSourcePath },
                ...modulePlan.acceptanceRefs.map(ref => ({ type: 'acceptance', ref }))
            ],
            allowedFiles,
            methodPolicy: {
                skeletonDefaultMethods: '基础方法只能来自 design_tdd_skeleton_materialize 返回的 materializedFiles[].methodSignatures / methodNames',
                businessExtensionMethods: businessExtensionSeeds.length > 0
                    ? businessExtensionSeeds.map(seed => `${seed.methodName}(${seed.tddIntent} -> ${seed.plannedConsumer})`).join('；')
                    : '本模块无业务扩展方法种子；禁止为了展示新增方法名'
            },
            businessExtensionSeeds,
            forbiddenActions: [
                'search_other_demand_code',
                'invent_page_name_or_file_path',
                'invent_service_method_without_contract_seed',
                'expand_to_unlocked_module',
                'modify_outside_current_demand_scope'
            ],
            nextAction: '骨架全部完成后，由 Coder 按完整 Story 连续组织实现批次，并在实施计划中记录验证结果。'
        };
    }

    _canonicalizeCarriedQueryModules(modules = []) {
        const workingModules = (Array.isArray(modules) ? modules : []).map(module => {
            if (!module || typeof module !== 'object') return module;
            return JSON.parse(JSON.stringify(module));
        });
        const modulesById = new Map(workingModules
            .map(module => [this._moduleId(module), module])
            .filter(([moduleId, module]) => moduleId && module));

        for (const module of workingModules) {
            const handoff = this._getHandoff(module);
            const surface = handoff.querySurface || module.querySurface || {};
            const bindingSurface = (Array.isArray(handoff.constructionBindings) ? handoff.constructionBindings : [])
                .find(binding => binding && binding.querySurface && binding.querySurface.mode);
            const declaredSurface = surface && surface.mode
                ? surface
                : (bindingSurface && bindingSurface.querySurface ? bindingSurface.querySurface : null);
            if (!handoff.surfaceIdentity && declaredSurface && declaredSurface.mode === 'independent') {
                handoff.surfaceIdentity = `admin:${String(module.objectKey || '').trim()}:list:${String(declaredSurface.pageKey || 'default').trim()}`;
            }
            if (!this._isDefaultCarriedQueryModule(module, handoff)) continue;

            const carriedByModuleId = String(this._pick(
                handoff.carriedByModuleId,
                module.carriedByModuleId
            ) || '').trim();
            const carrier = modulesById.get(carriedByModuleId);
            if (!carrier) continue;
            const carrierHandoff = this._getHandoff(carrier);
            const identity = {
                bizModule: this._pick(carrierHandoff.bizModule, carrier.bizModule),
                domain: this._pick(carrierHandoff.domain, carrier.domain),
                entityName: this._pick(carrierHandoff.entityName, carrier.entityName, carrierHandoff.EntityName),
                featureName: this._pick(carrierHandoff.featureName, carrier.featureName),
                pageName: this._pick(
                    carrierHandoff.pageName,
                    carrierHandoff.pagename,
                    carrier.pageName,
                    carrier.pagename
                )
            };

            Object.entries(identity).forEach(([key, value]) => {
                const normalized = String(value || '').trim();
                if (!normalized) return;
                module[key] = normalized;
                handoff[key] = normalized;
            });
            if (identity.entityName) handoff.EntityName = identity.entityName;
            handoff.surfaceIdentity = `admin:${String(module.objectKey || carrier.objectKey || '').trim()}:list:default`;

            if (Array.isArray(handoff.htmlPages)) {
                handoff.htmlPages = handoff.htmlPages.map(seed => ({
                    ...seed,
                    bizModule: identity.bizModule || seed.bizModule,
                    pageName: identity.pageName || seed.pageName || seed.pagename,
                    pagename: identity.pageName || seed.pagename || seed.pageName
                }));
            }
        }
        return workingModules;
    }

    _isDefaultCarriedQueryModule(module = {}, handoff = {}) {
        const carriedByModuleId = String(this._pick(
            handoff.carriedByModuleId,
            module.carriedByModuleId
        ) || '').trim();
        if (!carriedByModuleId) return false;

        const constructionSceneKey = String(this._pick(
            handoff.constructionSceneKey,
            module.constructionSceneKey
        ) || '').trim().toLowerCase();
        if (constructionSceneKey === 'statistics_analysis' || constructionSceneKey === 'rest_interface') return false;

        const surface = handoff.querySurface || module.querySurface || {};
        const bindingSurface = (Array.isArray(handoff.constructionBindings) ? handoff.constructionBindings : [])
            .find(binding => binding && binding.querySurface && binding.querySurface.mode);
        const surfaceMode = String(
            (surface && surface.mode)
            || (bindingSurface && bindingSurface.querySurface && bindingSurface.querySurface.mode)
            || handoff.querySurfaceMode
            || module.querySurfaceMode
            || ''
        ).trim().toLowerCase();
        if (surfaceMode === 'independent') return false;

        const fileSeeds = handoff.fileSeeds || handoff.files || handoff.filePlan || [];
        const htmlSeeds = handoff.htmlPages || handoff.pageSeeds || [];
        const hasQueryOnlySeed = (Array.isArray(fileSeeds) && fileSeeds.some(seed => seed && seed.queryOnly === true))
            || (Array.isArray(htmlSeeds) && htmlSeeds.some(seed => seed && seed.queryOnly === true))
            || handoff.queryOnly === true
            || module.queryOnly === true;
        const isQueryScene = ['query_result_entry', 'query_only', 'query_list'].includes(constructionSceneKey);
        const capability = String(this._pick(handoff.capability, module.capability) || '').trim().toLowerCase();
        return hasQueryOnlySeed || isQueryScene || capability === 'query';
    }

    _getHandoff(module = {}) {
        const candidates = [
            module.codingHandoff,
            module.codeHandoff,
            module.codePlanSeed,
            module.codePlanSeeds,
            module.implementationHandoff
        ];
        for (const item of candidates) {
            if (item && typeof item === 'object' && !Array.isArray(item)) {
                return item;
            }
        }
        return {};
    }

    _normalizeFileSeeds(handoff = {}, projection = {}) {
        const raw = handoff.fileSeeds || handoff.files || handoff.filePlan || [];
        const seeds = Array.isArray(raw) ? raw.filter(item => item && typeof item === 'object') : [];
        const reuseServiceSeeds = this._generatedReuseQueryServiceSeeds(seeds, projection);
        const constructionSceneKey = String(
            projection.constructionSceneKey || handoff.constructionSceneKey || ''
        ).trim();
        const carriedByModuleId = String(
            projection.carriedByModuleId || handoff.carriedByModuleId || ''
        ).trim();
        if (constructionSceneKey === 'statistics_analysis' && carriedByModuleId) {
            return reuseServiceSeeds.filter(seed => String(seed && seed.fileKind || '').trim() === 'Action');
        }
        return this._autoCompleteBackendQuartet(reuseServiceSeeds);
    }

    _ensureServiceOnlyFileSeeds(seeds = [], context = {}) {
        const scene = String(context.constructionSceneKey || '').trim();
        const carriedByModuleId = String(context.carriedByModuleId || '').trim();
        if (carriedByModuleId) return seeds;
        const contracts = Array.isArray(context.statisticsContracts) ? context.statisticsContracts : [];
        const hasEntitySeed = (Array.isArray(seeds) ? seeds : []).some(seed =>
            String(seed && seed.fileKind || '').trim() === 'Entity'
        );
        // 外部 UI/系统只要求本系统提供 REST 时，Story 可以没有本地表。
        // 这类模块仍需要 Service 三层承载业务能力，但 REST 不应再被依赖图强制绑定 Entity。
        const externalRestWithoutEntity = scene === 'rest_interface' && !hasEntitySeed;
        const hasServiceOnlySeed = (Array.isArray(seeds) ? seeds : []).some(seed => {
            const kind = String(seed && seed.fileKind || '').trim();
            return SERVICE_BUNDLE_KINDS.includes(kind)
                && (seed.serviceOnly === true || seed.noEntity === true);
        });
        if (scene !== 'statistics_analysis' && !externalRestWithoutEntity && contracts.length === 0 && !hasServiceOnlySeed) return seeds;

        const serviceKinds = new Set(['ServiceApi', 'ServiceInternal', 'ServiceImpl']);
        const storyIds = this._normalizeStringList(
            contracts.flatMap(contract => [contract && contract.storyId, contract && contract.sourceStoryId])
        ).map(storyId => storyId.toUpperCase());
        const normalized = (Array.isArray(seeds) ? seeds : []).map(seed => {
            const kind = String(seed && seed.fileKind || '').trim();
            if (externalRestWithoutEntity && ['Rest', 'Action', 'Job'].includes(kind)) {
                return {
                    ...seed,
                    serviceOnly: true,
                    noEntity: true,
                    projectionSource: seed.projectionSource || 'external_rest_service_only',
                    managedProjection: true
                };
            }
            if (!serviceKinds.has(String(seed && seed.fileKind || '').trim())) return seed;
            return {
                ...seed,
                serviceOnly: true,
                noEntity: true,
                ...(storyIds.length > 0 ? { storyIds: this._normalizeStringList(seed.storyIds, storyIds).map(id => id.toUpperCase()) } : {}),
                projectionSource: seed.projectionSource || (scene === 'statistics_analysis'
                    ? 'statistics_service_only'
                    : 'service_only'),
                managedProjection: true
            };
        });
        const presentKinds = new Set(normalized
            .map(seed => String(seed && seed.fileKind || '').trim())
            .filter(kind => serviceKinds.has(kind)));
        if (presentKinds.size === serviceKinds.size) return normalized;

        const anchor = normalized.find(seed => String(seed && seed.fileKind || '').trim() === 'Action')
            || normalized.find(seed => String(seed && seed.fileKind || '').trim() === 'HtmlPage')
            || normalized[0];
        if (!anchor) return normalized;
        const serviceAnchor = {
            fileKind: 'ServiceApi',
            operation: String(anchor.operation || 'create').trim() || 'create',
            evidenceRef: String(anchor.evidenceRef || context.moduleId || '').trim(),
            serviceOnly: true,
            noEntity: true,
            ...(storyIds.length > 0 ? { storyIds } : {}),
            projectionSource: scene === 'statistics_analysis' ? 'statistics_service_only' : 'service_only',
            managedProjection: true,
            _autoCompletedByBuilder: true,
            _autoCompleteReason: scene === 'statistics_analysis'
                ? 'statistics_service_only_bundle_required_without_carrier'
                : 'service_only_bundle_required_without_carrier'
        };
        return this._autoCompleteBackendQuartet(normalized.concat(serviceAnchor));
    }

    // 保留旧方法名供历史测试/调用者兼容；新逻辑按 serviceOnly/noEntity 结构判断，
    // 不再把 Service-only 投影绑定到 statistics_analysis 场景名。
    _ensureStatisticsServiceOnlyFileSeeds(seeds = [], context = {}) {
        return this._ensureServiceOnlyFileSeeds(seeds, context);
    }

    _generatedReuseQueryServiceSeeds(seeds = [], projection = {}) {
        const module = projection.module && typeof projection.module === 'object' ? projection.module : {};
        const handoff = this._getHandoff(module);
        const moduleId = String(projection.moduleId || this._moduleId(module) || '').trim();
        const carriedByModuleId = String(
            projection.carriedByModuleId || handoff.carriedByModuleId || module.carriedByModuleId || ''
        ).trim();
        if (carriedByModuleId || !this._isQueryOnlyModule(module, handoff)) return seeds;

        const designDocument = projection.designDocument && typeof projection.designDocument === 'object'
            ? projection.designDocument
            : {};
        const tables = designDocument.databaseDesign && Array.isArray(designDocument.databaseDesign.tables)
            ? designDocument.databaseDesign.tables
            : [];
        const objectKey = String(
            handoff.objectKey || module.objectKey || module.entityKey || ''
        ).trim();
        const relatedTables = tables.filter(table => {
            if (!table || typeof table !== 'object') return false;
            const related = Array.isArray(table.relatedModuleIds) ? table.relatedModuleIds : [];
            if (moduleId && related.map(item => String(item || '').trim()).includes(moduleId)) return true;
            return objectKey && String(table.objectKey || '').trim() === objectKey;
        });
        const reuseTable = relatedTables.find(table => this._isReuseTable(table));
        if (!reuseTable) return seeds;
        const reusedApis = this._normalizeStringList(reuseTable.reusedApis).filter(Boolean);
        if (reusedApis.length > 0) return seeds;

        const hasEvidence = Boolean(
            String(reuseTable.reuseSourceFile || '').trim()
            || this._normalizeStringList(reuseTable.reuseDirHints).length > 0
            || (Array.isArray(reuseTable.columns) && reuseTable.columns.length > 0)
        );

        // 先用与数据访问计划相同的详细解析结果判断：
        //   - 刷新失败/候选不明确：有复用表来源证据时允许按证据生成只读 Service，
        //     没有证据仍保持原 seeds，稍后的 dataAccessPlan 会明确 blocked；
        //   - 刷新后找到旧 Service：保持原 seeds，不重复生成 Service 三层；
        //   - 明确 not_found：才允许在复用表证据齐全时补只读 Service 三层。
        const projectPath = String(projection.projectPath || '').trim();
        const dataAccess = this.dataAccessPlanService;
        if (projectPath && dataAccess) {
            if (typeof dataAccess.resolvePagingService === 'function') {
                const resolution = dataAccess.resolvePagingService(projectPath, reuseTable);
                if (!resolution) return seeds;
                if (resolution.service) return seeds;
                if (resolution.status === 'ambiguous' || (resolution.ok !== true && !hasEvidence)) return seeds;
            } else if (typeof dataAccess._findGenericPagingService === 'function'
                && dataAccess._findGenericPagingService(projectPath, reuseTable)) {
                // 历史注入的简化 DataAccess service 仍按“找到即复用”兼容。
                return seeds;
            }
        }
        if (!hasEvidence) return seeds;

        const existing = Array.isArray(seeds) ? seeds : [];
        const serviceKinds = new Set(SERVICE_BUNDLE_KINDS);
        const normalized = existing
            .filter(seed => !(String(seed && seed.fileKind || '').trim() === 'Entity'
                && String(seed && seed.operation || 'create').trim() === 'create'))
            .map(seed => serviceKinds.has(String(seed && seed.fileKind || '').trim())
                ? {
                    ...seed,
                    serviceOnly: true,
                    noEntity: true,
                    projectionSource: seed.projectionSource || 'reuse_query_generated_service',
                    managedProjection: true
                }
                : seed);
        const presentServiceKinds = new Set(normalized
            .map(seed => String(seed && seed.fileKind || '').trim())
            .filter(kind => serviceKinds.has(kind)));
        if (presentServiceKinds.size === serviceKinds.size) return normalized;

        const anchor = normalized.find(seed => String(seed && seed.fileKind || '').trim() === 'Action')
            || normalized.find(seed => String(seed && seed.fileKind || '').trim() === 'HtmlPage')
            || normalized[0];
        if (!anchor) return normalized;
        const storyIds = this._normalizeStringList(
            anchor.storyIds,
            anchor.writeStoryIds,
            module.storyId,
            module.relatedStoryIds,
            handoff.storyIds,
            handoff.relatedStoryIds
        ).map(storyId => storyId.toUpperCase());
        const serviceAnchor = {
            fileKind: 'ServiceApi',
            operation: 'create',
            evidenceRef: String(anchor.evidenceRef || moduleId || '').trim(),
            serviceOnly: true,
            noEntity: true,
            ...(moduleId ? { moduleId } : {}),
            ...((anchor.objectKey || module.objectKey || module.entityKey)
                ? { objectKey: anchor.objectKey || module.objectKey || module.entityKey }
                : {}),
            ...(storyIds.length > 0 ? { storyIds } : {}),
            projectionSource: 'reuse_query_generated_service',
            managedProjection: true,
            _autoCompletedByBuilder: true,
            _autoCompleteReason: 'reuse_query_service_required_without_api'
        };
        return this._autoCompleteBackendQuartet(normalized.concat(serviceAnchor));
    }

    _isQueryOnlyModule(module = {}, handoff = {}) {
        const scene = String(this._pick(
            handoff.constructionSceneKey,
            module.constructionSceneKey
        ) || '').trim().toLowerCase();
        if (['query_result_entry', 'query_only', 'query_list'].includes(scene)) return true;
        const fileSeeds = handoff.fileSeeds || handoff.files || handoff.filePlan || [];
        const htmlSeeds = handoff.htmlPages || handoff.pageSeeds || [];
        return (Array.isArray(fileSeeds) && fileSeeds.some(seed => seed && seed.queryOnly === true))
            || (Array.isArray(htmlSeeds) && htmlSeeds.some(seed => seed && seed.queryOnly === true))
            || handoff.queryOnly === true
            || module.queryOnly === true
            || String(this._pick(handoff.capability, module.capability) || '').trim().toLowerCase() === 'query';
    }

    _isReuseTable(table = {}) {
        if (!table || typeof table !== 'object') return false;
        return table.reuse === true
            || String(table.kind || '').trim().toLowerCase() === 'reuse'
            || !!String(table.reuseSourceFile || '').trim()
            || this._normalizeStringList(table.reusedApis).length > 0
            || this._normalizeStringList(table.reuseDirHints).length > 0;
    }

    /**
     * Builder-owned 衍生事实：后端 4 件套自动补全。
     *
     * 950以下/950及以上规则模板都把后端拆成 4 个文件：
     *   1) Entity              数据库实体
     *   2) ServiceApi          接口层（IGxh{X}Service.java）
     *   3) ServiceInternal     内部逻辑层（Gxh{X}Service.java，持有 baseDao = CommonDao.getInstance()）
     *   4) ServiceImpl         外壳层（Gxh{X}ServiceImpl.java，每个方法 new ServiceInternal().xxx() 转发）
     *
     * 设计阶段 LLM 经常只列 3 件套（Entity + ServiceApi + ServiceImpl），漏 ServiceInternal。
     * 漏了之后骨架物化只跑 ServiceImpl，物化产物是个空 @Component 类，编译不过；
     * LLM 看到空类 → 自己发明 DAO 注入方案（如 SpringContextUtil.getBean），整个 DAO 注入约定崩盘。
     *
     * 修法：本方法做"Builder-owned 衍生补全"——只要 fileSeeds 里出现任意一个后端层
     * （Entity / ServiceApi / ServiceInternal / ServiceImpl），就 ensure 4 件套齐全。
     * 缺哪个，按"和最近一个后端 seed 同 operation/evidenceRef"补一份；HtmlPage / Action 不动。
     *
     * AGENTS.md 红线对照：
     *   - 确定事实不进 LLM 视野：4 件套是规则模板硬性约定，给定任一后端 seed，确定补另 3 个 → Builder-owned
     *   - 不裁判业务：本补全不看模块名/字段含义，只看"出现后端 seed 即补齐 4 件套"的结构关系
     *   - 不复制合同：补出的 seed 直接以原始 seed 的 operation/evidenceRef 复用，不引入新合同
     *
     * 不补全的场景：
     *   - 完全没后端 seed（纯前端模块、纯 Job 模块）
     *   - carriedByModuleId 模块（设计阶段已声明承载，本模块本身无产物）—— 由调用方过滤，本方法只看 seeds
     */
    /**
     * 前端 HtmlPage CRUD 补全（聚合级，跨模块）。
     *
     * 规则：扫所有模块 codingHandoff.htmlPages[]，按 **(bizModule, pageName)** 聚合；
     * 任一聚合中出现 `subType=list` → ensure 同 (bizModule, pageName) 也有 add / edit / detail；
     * 缺的子类型直接补到"声明 list 的那个模块" handoff.htmlPages 末尾。
     *
     * 为什么用 (bizModule, pageName) 而非 bizModule 单独：同一 bizModule 下可能存在多个独立
     * 页面族（如 venue 包含 venue 主页面 + venuewindow 子页面），它们通过 pageName 区分物理
     * 文件名（gxhvenuelist.html / gxhvenuewindowlist.html）。CRUD 补全是针对单个页面族的，
     * 不能把两个页面族的 subType 当作同一聚合的 subType 集合。
     *
     * 只有已确认的 list 页族会机械补齐其模板引用的 add/edit/detail。
     * 单 edit/detail 和 Entity-only 承载不会在 plan 层被扩张成新的页面族；
     * 页面族的权威来源是 Design Builder 产出的 fileSet/htmlPages。
     *
     * AGENTS.md 红线对照：
     *   - Builder-owned 衍生事实（仅闭合已存在 list 模板的固定链接）
     *   - 不裁判业务（不看 user story、不看模块名，只看 (bizModule, pageName, subType) 集合的结构关系）
     *   - LLM 视野无感（直接修 handoff.htmlPages，下游 _normalizeHtmlSeeds 自然消费）
     *   - pageName 不猜——补出来的 seed 沿用 list seed 的 pageName，不发明新名字
     *
     * 注意：本方法**直接修改入参 module.codingHandoff.htmlPages**（in-place）。这在 plan 内
     * 部循环中是安全的——modules 是 Builder 内部工作对象，不会回写到设计 JSON。
     */
    _autoCompleteCrudHtmlPages(modules) {
        if (!Array.isArray(modules)) return;
        const REQUIRED_SUBTYPES = ['add', 'edit', 'detail'];
        // 聚合 key=`${bizModule}::${pageName}` → { listModuleIndex, listSeed, presentSubTypes }
        const aggregates = new Map();
        modules.forEach((module, idx) => {
            const handoff = this._getHandoff(module);
            if (handoff.excludedFromCoding === true || module.excludedFromCoding === true) return;
            if (this._isRestInterfaceScene(module, handoff)) return;
            const bizModule = String(this._pick(handoff.bizModule, module.bizModule) || '').trim();
            if (!bizModule) return;
            const seeds = Array.isArray(handoff.htmlPages) ? handoff.htmlPages : [];
            for (const seed of seeds) {
                if (!seed || typeof seed !== 'object') continue;
                const subType = String(seed.subType || '').trim().toLowerCase();
                if (!subType) continue;
                if (this._shouldSkipCrudAutoComplete(seed)) continue;
                const pageName = String(
                    seed.pageName || seed.pagename
                    || handoff.pageName || handoff.pagename
                    || module.pageName || module.pagename
                    || ''
                ).trim();
                if (!pageName) continue;
                const aggKey = `${bizModule}::${pageName}`;
                if (!aggregates.has(aggKey)) {
                    aggregates.set(aggKey, {
                        bizModule,
                        pageName,
                        listModuleIndex: -1,
                        listSeed: null,
                        queryOnlyList: false,
                        presentSubTypes: new Set(),
                        firstModuleIndex: idx
                    });
                }
                const agg = aggregates.get(aggKey);
                agg.presentSubTypes.add(subType);
                if (subType === 'list' && agg.listModuleIndex === -1) {
                    agg.listModuleIndex = idx;
                    agg.listSeed = seed;
                    agg.queryOnlyList = seed.queryOnly === true;
                }
            }
        });

        // 对每个含 list 的聚合补缺失子类型；不含 list 的聚合不补
        for (const [, agg] of aggregates.entries()) {
            if (agg.listModuleIndex === -1) continue; // 没 list → 不触发
            if (agg.queryOnlyList === true) continue; // 查询入口 list 不补 CRUD 页面族
            const missing = REQUIRED_SUBTYPES.filter(st => !agg.presentSubTypes.has(st));
            if (missing.length === 0) continue;

            const ownerModule = modules[agg.listModuleIndex];
            const ownerHandoff = this._getHandoff(ownerModule);
            if (!Array.isArray(ownerHandoff.htmlPages)) ownerHandoff.htmlPages = [];
            for (const subType of missing) {
                ownerHandoff.htmlPages.push({
                    subType,
                    pageName: agg.pageName,
                    bizModule: agg.bizModule,
                    evidenceRef: String(agg.listSeed.evidenceRef || ownerModule.moduleId || '').trim(),
                    _autoCompletedByBuilder: true,
                    _autoCompleteReason: 'crud_quartet_required_when_list_present'
                });
            }
        }

    }

    _autoCompleteActionSeedsFromHtmlPages(modules) {
        if (!Array.isArray(modules)) return;
        for (const module of modules) {
            if (!module || typeof module !== 'object') continue;
            const handoff = this._getHandoff(module);
            if (this._isCarriedOnlyModule(module, handoff)) continue;
            if (handoff.excludedFromCoding === true || module.excludedFromCoding === true) continue;
            if (this._isRestInterfaceScene(module, handoff)) continue;
            const htmlSeeds = this._normalizeHtmlSeeds(handoff);
            if (htmlSeeds.length === 0) continue;
            const rawFileSeeds = Array.isArray(handoff.fileSeeds || handoff.files || handoff.filePlan)
                ? (handoff.fileSeeds || handoff.files || handoff.filePlan)
                : [];
            const actionSubTypes = new Set(rawFileSeeds
                .filter(seed => seed && String(seed.fileKind || '').trim() === 'Action')
                .map(seed => String(seed.subType || '').trim().toLowerCase() || 'list'));
            const actionSeedsToAdd = [];
            for (const htmlSeed of htmlSeeds) {
                const subType = String(htmlSeed && htmlSeed.subType || '').trim().toLowerCase();
                const actionSubType = subType === 'workflowdetail' ? 'workflow' : subType;
                if (!actionSubType || actionSubTypes.has(actionSubType)) continue;
                actionSubTypes.add(actionSubType);
                actionSeedsToAdd.push({
                    fileKind: 'Action',
                    subType: actionSubType,
                    operation: String(htmlSeed.operation || 'create').trim() || 'create',
                    evidenceRef: String(htmlSeed.evidenceRef || module.moduleId || '').trim(),
                    ...(htmlSeed.queryOnly === true ? { queryOnly: true } : {}),
                    ...(htmlSeed.statisticsOnly === true ? { statisticsOnly: true } : {}),
                    ...(htmlSeed.targetPageRole ? { targetPageRole: htmlSeed.targetPageRole } : {}),
                    ...(htmlSeed.interactionCarrier ? { interactionCarrier: htmlSeed.interactionCarrier } : {}),
                    _autoCompletedByBuilder: true,
                    _autoCompleteReason: 'action_subtype_required_by_htmlpage_subtype'
                });
            }
            if (actionSeedsToAdd.length === 0) continue;
            if (Array.isArray(handoff.fileSeeds)) {
                handoff.fileSeeds = rawFileSeeds.concat(actionSeedsToAdd);
            } else if (Array.isArray(handoff.files)) {
                handoff.files = rawFileSeeds.concat(actionSeedsToAdd);
            } else if (Array.isArray(handoff.filePlan)) {
                handoff.filePlan = rawFileSeeds.concat(actionSeedsToAdd);
            } else {
                handoff.fileSeeds = actionSeedsToAdd;
            }
        }
    }

    _autoCompleteWorkflowProcessSeeds(modules, options = {}) {
        if (!Array.isArray(modules)) return;
        const FULL_WORKFLOW_ACTION_SUBTYPES = ['list', 'mylist', 'add', 'edit', 'detail', 'workflow'];
        const FULL_WORKFLOW_HTML_SUBTYPES = [...FULL_WORKFLOW_ACTION_SUBTYPES, 'workflowdetail'];
        const WORKFLOW_ONLY_ACTION_SUBTYPES = ['mylist', 'workflow'];
        const WORKFLOW_ONLY_HTML_SUBTYPES = [...WORKFLOW_ONLY_ACTION_SUBTYPES, 'workflowdetail'];
        const BACKEND_KINDS = ['Entity', 'ServiceApi', 'ServiceInternal', 'ServiceImpl'];
        const projectPath = String(options.projectPath || '').trim();
        const paths = options.paths || {};
        const placementContracts = options.placementContracts || {};
        const htmlContract = options.htmlContract || placementContracts.HtmlPage || {};
        const sharedOptions = { projectPath, paths, placementContracts, htmlContract };
        for (const module of modules) {
            if (!module || typeof module !== 'object') continue;
            const handoff = this._getHandoff(module);
            if (handoff.excludedFromCoding === true || module.excludedFromCoding === true) continue;
            if (!this._isWorkflowProcessScene(module, handoff)) continue;
            const workflowContracts = this._normalizeWorkflowContracts(
                handoff.workflowContracts || module.workflowContracts,
                handoff.workflowContract || module.workflowContract
            );
            if (workflowContracts.length === 0) continue;
            const moduleId = this._moduleId(module);
            const workflowIdentity = this._moduleCodingIdentity(module, handoff);
            if (!moduleId || !workflowIdentity.bizModule || !workflowIdentity.pageName) continue;

            const rawWorkflowContracts = this._rawWorkflowContracts(
                handoff.workflowContracts || module.workflowContracts,
                handoff.workflowContract || module.workflowContract
            );
            const explicitPageSet = rawWorkflowContracts
                .map(contract => String(contract && contract.pageSet || '').trim().toLowerCase())
                .find(Boolean);
            const carrier = this._resolveWorkflowCrudCarrier(module, modules, sharedOptions);
            const targetModule = carrier && carrier.module ? carrier.module : module;
            const targetHandoff = carrier && carrier.handoff ? carrier.handoff : handoff;
            const targetIdentity = carrier && carrier.identity ? carrier.identity : workflowIdentity;
            const workflowActionSubTypes = explicitPageSet === 'workflow_minimal'
                ? WORKFLOW_ONLY_ACTION_SUBTYPES
                : carrier
                    ? WORKFLOW_ONLY_ACTION_SUBTYPES
                    : explicitPageSet === 'full_workflow_pages'
                        ? FULL_WORKFLOW_ACTION_SUBTYPES
                        : this._moduleHasCrudCarrier(module, sharedOptions)
                        ? WORKFLOW_ONLY_ACTION_SUBTYPES
                        : FULL_WORKFLOW_ACTION_SUBTYPES;
            const workflowHtmlSubTypes = explicitPageSet === 'workflow_minimal'
                ? WORKFLOW_ONLY_HTML_SUBTYPES
                : carrier
                    ? WORKFLOW_ONLY_HTML_SUBTYPES
                    : explicitPageSet === 'full_workflow_pages'
                        ? FULL_WORKFLOW_HTML_SUBTYPES
                        : this._moduleHasCrudCarrier(module, sharedOptions)
                        ? WORKFLOW_ONLY_HTML_SUBTYPES
                        : FULL_WORKFLOW_HTML_SUBTYPES;

            const rawFileSeeds = this._rawFileSeedArray(targetHandoff);
            const fileSeedsToAdd = [];
            const hasFileSeed = (fileKind, subType = '') => rawFileSeeds.some(seed => {
                if (!seed || typeof seed !== 'object') return false;
                if (String(seed.fileKind || '').trim() !== fileKind) return false;
                if (!subType) return true;
                return (String(seed.subType || '').trim().toLowerCase() || 'list') === subType;
            });
            if (!carrier) {
                for (const fileKind of BACKEND_KINDS) {
                    if (!hasFileSeed(fileKind)
                        && !this._workflowFileExists(fileKind, '', targetIdentity, { projectPath, paths, placementContracts })) {
                        fileSeedsToAdd.push({
                            fileKind,
                            operation: 'create',
                            evidenceRef: moduleId,
                            _autoCompletedByBuilder: true,
                            _autoCompleteReason: 'workflow_process_requires_company_workflow_skeleton'
                        });
                    }
                }
            }
            for (const subType of workflowActionSubTypes) {
                if (!hasFileSeed('Action', subType)
                    && !this._workflowFileExists('Action', subType, targetIdentity, { projectPath, paths, placementContracts })) {
                    fileSeedsToAdd.push({
                        fileKind: 'Action',
                        subType,
                        operation: 'create',
                        evidenceRef: moduleId,
                        sourceModuleId: moduleId,
                        entityName: targetIdentity.entityName,
                        featureName: targetIdentity.featureName,
                        pageName: targetIdentity.pageName,
                        pagename: targetIdentity.pageName,
                        bizModule: targetIdentity.bizModule,
                        domain: targetIdentity.domain,
                        _autoCompletedByBuilder: true,
                        _autoCompleteReason: carrier
                            ? 'workflow_process_extends_carrier_crud_module'
                            : 'workflow_process_requires_company_workflow_skeleton'
                    });
                }
            }
            this._appendFileSeeds(targetHandoff, rawFileSeeds, fileSeedsToAdd);

            const rawHtmlSeeds = this._rawHtmlSeedArray(targetHandoff);
            const htmlSeedsToAdd = [];
            const hasHtmlSeed = subType => rawHtmlSeeds.some(seed =>
                seed
                && typeof seed === 'object'
                && (String(seed.subType || '').trim().toLowerCase() || 'list') === subType
                && String(this._pick(seed.bizModule, targetIdentity.bizModule) || '').trim() === targetIdentity.bizModule
                && String(this._pick(seed.pageName, seed.pagename, targetIdentity.pageName) || '').trim().toLowerCase() === targetIdentity.pageName
            );
            for (const subType of workflowHtmlSubTypes) {
                if (!hasHtmlSeed(subType)
                    && !this._workflowHtmlExists(subType, targetIdentity, { projectPath, htmlContract })) {
                    htmlSeedsToAdd.push({
                        subType,
                        pageName: targetIdentity.pageName,
                        pagename: targetIdentity.pageName,
                        bizModule: targetIdentity.bizModule,
                        evidenceRef: moduleId,
                        sourceModuleId: moduleId,
                        ...(subType === 'workflowdetail' ? { sectionKey: 'WorkflowDetailHtmlPage', targetPageRole: 'workflow_detail' } : {}),
                        _autoCompletedByBuilder: true,
                        _autoCompleteReason: carrier
                            ? 'workflow_process_extends_carrier_crud_module'
                            : 'workflow_process_requires_company_workflow_skeleton'
                    });
                }
            }
            this._appendHtmlSeeds(targetHandoff, rawHtmlSeeds, htmlSeedsToAdd);
        }
    }

    _moduleCodingIdentity(module = {}, handoff = null) {
        const currentHandoff = handoff || this._getHandoff(module);
        const entityName = String(this._pick(currentHandoff.entityName, module.entityName, currentHandoff.EntityName) || '').trim();
        const featureName = String(this._pick(currentHandoff.featureName, module.featureName, entityName) || '').trim();
        const pageName = String(this._pick(
            currentHandoff.pageName,
            currentHandoff.pagename,
            module.pageName,
            module.pagename,
            entityName,
            featureName
        ) || '').trim().toLowerCase();
        return {
            moduleId: this._moduleId(module),
            bizModule: String(this._pick(currentHandoff.bizModule, module.bizModule) || '').trim(),
            domain: String(this._pick(currentHandoff.domain, module.domain) || '').trim(),
            entityName,
            featureName,
            pageName
        };
    }

    _resolveWorkflowCrudCarrier(workflowModule = {}, modules = [], options = {}) {
        const workflowHandoff = this._getHandoff(workflowModule);
        const carriedByModuleId = String(this._pick(
            workflowHandoff.carriedByModuleId,
            workflowModule.carriedByModuleId,
            workflowModule.businessContext && workflowModule.businessContext.carriedByModuleId
        ) || '').trim();
        if (carriedByModuleId) {
            const carriedModule = modules.find(item => this._moduleId(item) === carriedByModuleId);
            if (carriedModule) {
                const handoff = this._getHandoff(carriedModule);
                if (this._moduleHasCrudCarrier(carriedModule, options)) {
                    return {
                        module: carriedModule,
                        handoff,
                        identity: this._moduleCodingIdentity(carriedModule, handoff),
                        reason: 'carriedByModuleId'
                    };
                }
            }
        }
        const workflowIdentity = this._moduleCodingIdentity(workflowModule, workflowHandoff);
        const workflowObjectKey = this._normalizeBusinessKey(this._pick(workflowModule.aggregateRoot, workflowModule.businessObject, workflowHandoff.aggregateRoot, workflowHandoff.businessObject));
        for (const candidate of modules) {
            if (!candidate || candidate === workflowModule) continue;
            const candidateHandoff = this._getHandoff(candidate);
            if (candidateHandoff.excludedFromCoding === true || candidate.excludedFromCoding === true) continue;
            if (this._isWorkflowProcessScene(candidate, candidateHandoff)) continue;
            const candidateIdentity = this._moduleCodingIdentity(candidate, candidateHandoff);
            const candidateObjectKey = this._normalizeBusinessKey(this._pick(candidate.aggregateRoot, candidate.businessObject, candidateHandoff.aggregateRoot, candidateHandoff.businessObject));
            if (!candidateObjectKey || candidateObjectKey !== workflowObjectKey) continue;
            if (!this._moduleHasCrudCarrier(candidate, options)) continue;
            return {
                module: candidate,
                handoff: candidateHandoff,
                identity: candidateIdentity,
                reason: 'sameAggregateRoot'
            };
        }
        const byTablePrefix = modules.find(candidate => {
            if (!candidate || candidate === workflowModule) return false;
            const candidateHandoff = this._getHandoff(candidate);
            if (this._isWorkflowProcessScene(candidate, candidateHandoff)) return false;
            const candidateIdentity = this._moduleCodingIdentity(candidate, candidateHandoff);
            if (!candidateIdentity.pageName || !workflowIdentity.pageName) return false;
            if (!workflowIdentity.pageName.startsWith(candidateIdentity.pageName)) return false;
            return this._moduleHasCrudCarrier(candidate, options);
        });
        if (byTablePrefix) {
            const handoff = this._getHandoff(byTablePrefix);
            return {
                module: byTablePrefix,
                handoff,
                identity: this._moduleCodingIdentity(byTablePrefix, handoff),
                reason: 'pageNamePrefix'
            };
        }
        return null;
    }

    _moduleHasCrudCarrier(module = {}, options = {}) {
        const handoff = this._getHandoff(module);
        const identity = this._moduleCodingIdentity(module, handoff);
        const fileSeeds = this._rawFileSeedArray(handoff);
        const htmlSeeds = this._rawHtmlSeedArray(handoff);
        const crudSubTypes = new Set(['list', 'add', 'edit', 'detail']);
        if (fileSeeds.some(seed =>
            seed
            && typeof seed === 'object'
            && String(seed.fileKind || '').trim() === 'Action'
            && crudSubTypes.has(String(seed.subType || '').trim().toLowerCase() || 'list')
        )) return true;
        if (htmlSeeds.some(seed =>
            seed
            && typeof seed === 'object'
            && crudSubTypes.has(String(seed.subType || '').trim().toLowerCase() || 'list')
        )) return true;
        return Array.from(crudSubTypes).some(subType =>
            this._workflowFileExists('Action', subType, identity, options)
            || this._workflowHtmlExists(subType, identity, options)
        );
    }

    _rawFileSeedArray(handoff = {}) {
        const raw = handoff.fileSeeds || handoff.files || handoff.filePlan;
        return Array.isArray(raw) ? raw : [];
    }

    _rawHtmlSeedArray(handoff = {}) {
        const raw = handoff.htmlPages || handoff.pages;
        return Array.isArray(raw) ? raw : [];
    }

    _appendFileSeeds(handoff = {}, rawFileSeeds = [], seedsToAdd = []) {
        if (!Array.isArray(seedsToAdd) || seedsToAdd.length === 0) return;
        if (Array.isArray(handoff.fileSeeds)) {
            handoff.fileSeeds = rawFileSeeds.concat(seedsToAdd);
        } else if (Array.isArray(handoff.files)) {
            handoff.files = rawFileSeeds.concat(seedsToAdd);
        } else if (Array.isArray(handoff.filePlan)) {
            handoff.filePlan = rawFileSeeds.concat(seedsToAdd);
        } else {
            handoff.fileSeeds = seedsToAdd;
        }
    }

    _appendHtmlSeeds(handoff = {}, rawHtmlSeeds = [], seedsToAdd = []) {
        if (!Array.isArray(seedsToAdd) || seedsToAdd.length === 0) return;
        if (Array.isArray(handoff.htmlPages)) {
            handoff.htmlPages = rawHtmlSeeds.concat(seedsToAdd);
        } else if (Array.isArray(handoff.pages)) {
            handoff.pages = rawHtmlSeeds.concat(seedsToAdd);
        } else {
            handoff.htmlPages = seedsToAdd;
        }
    }

    _normalizeBusinessKey(value = '') {
        return String(value || '').trim().toLowerCase().replace(/[\s_\-流程工单业务表]+/gu, '');
    }

    _rawWorkflowContracts(value = [], fallback = null) {
        const raw = [];
        if (Array.isArray(value)) {
            value.forEach(item => {
                if (item && typeof item === 'object' && !Array.isArray(item)) raw.push(item);
            });
        } else if (value && typeof value === 'object' && !Array.isArray(value)) {
            raw.push(value);
        }
        if (raw.length === 0 && fallback && typeof fallback === 'object' && !Array.isArray(fallback)) raw.push(fallback);
        return raw;
    }

    _workflowFileExists(fileKind = '', subType = '', context = {}, options = {}) {
        const projectPath = String(options.projectPath || '').trim();
        if (!projectPath) return false;
        const resolved = this._resolveFileSeed({
            fileKind,
            ...(subType ? { subType } : {}),
            operation: 'create'
        }, {
            paths: options.paths || {},
            placementContracts: options.placementContracts || {},
            bizModule: context.bizModule,
            domain: context.domain,
            entityName: context.entityName,
            featureName: context.featureName || context.entityName,
            pageName: context.pageName,
            moduleId: context.moduleId
        });
        if (!resolved || resolved.ok !== true || !resolved.file || !resolved.file.resolvedPath) return false;
        return fs.existsSync(this._absoluteProjectPath(projectPath, resolved.file.resolvedPath));
    }

    _workflowHtmlExists(subType = '', context = {}, options = {}) {
        const projectPath = String(options.projectPath || '').trim();
        if (!projectPath) return false;
        const resolved = this._resolveHtmlPage(options.htmlContract || {}, {
            moduleId: context.moduleId,
            subType,
            bizModule: context.bizModule,
            pageName: context.pageName
        });
        if (!resolved || resolved.ok !== true || !resolved.file || !resolved.file.resolvedPath) return false;
        return fs.existsSync(this._absoluteProjectPath(projectPath, resolved.file.resolvedPath));
    }

    _absoluteProjectPath(projectPath = '', maybeRelativePath = '') {
        const raw = String(maybeRelativePath || '').trim();
        if (!raw) return '';
        if (path.isAbsolute(raw)) return raw;
        return path.resolve(String(projectPath || '').trim(), raw);
    }

    _autoCompleteBackendQuartet(seeds = []) {
        const BACKEND_KINDS = ['Entity', 'ServiceApi', 'ServiceInternal', 'ServiceImpl'];
        const SERVICE_ONLY_KINDS = ['ServiceApi', 'ServiceInternal', 'ServiceImpl'];
        const presentKinds = new Set();
        let anchorSeed = null;
        for (const seed of seeds) {
            const k = String(seed && seed.fileKind || '').trim();
            if (BACKEND_KINDS.includes(k)) {
                presentKinds.add(k);
                if (!anchorSeed || seed.serviceOnly === true || seed.noEntity === true) anchorSeed = seed;
            }
        }
        // 没有任何后端 seed —— 纯前端模块，不补
        if (presentKinds.size === 0) return seeds;
        const serviceOnly = !!(anchorSeed && (anchorSeed.serviceOnly === true || anchorSeed.noEntity === true));
        const requiredKinds = serviceOnly ? SERVICE_ONLY_KINDS : BACKEND_KINDS;
        // 已经齐全 —— 直接返回
        if (requiredKinds.every(k => presentKinds.has(k))) return seeds;

        const completed = seeds.slice();
        const operation = String(anchorSeed && anchorSeed.operation || 'create').trim();
        const evidenceRef = String(anchorSeed && anchorSeed.evidenceRef || '').trim();
        for (const kind of requiredKinds) {
            if (presentKinds.has(kind)) continue;
            const autoSeed = {
                ...anchorSeed,
                fileKind: kind,
                operation,
                ...(evidenceRef ? { evidenceRef } : {}),
                ...(serviceOnly ? { serviceOnly: true, noEntity: true } : {}),
                _autoCompletedByBuilder: true,
                _autoCompleteReason: serviceOnly
                    ? 'service_only_bundle_required_by_rule_template'
                    : 'backend_quartet_required_by_rule_template'
            };
            completed.push(autoSeed);
        }
        return completed;
    }

    _normalizeHtmlSeeds(handoff = {}) {
        const raw = handoff.htmlPages || handoff.pageSeeds || [];
        if (Array.isArray(raw) && raw.length > 0) {
            return raw.filter(item => item && typeof item === 'object');
        }
        const subTypes = Array.isArray(handoff.pageSubTypes) ? handoff.pageSubTypes : [];
        return subTypes.map(subType => ({
            subType,
            pageName: handoff.pageName || handoff.pagename,
            bizModule: handoff.bizModule
        }));
    }

    _normalizeContractSeeds(raw = []) {
        return Array.isArray(raw) ? raw.filter(item => item && typeof item === 'object') : [];
    }

    _extractPlacementContract(navigationContract = {}, fileKind = '') {
        const rules = Array.isArray(navigationContract.rulePlacementContract && navigationContract.rulePlacementContract.rules)
            ? navigationContract.rulePlacementContract.rules
            : [];
        return rules.find(rule => String(rule.fileKind || '').trim() === fileKind) || {};
    }

    _pathKeyForFileKind(fileKind = '') {
        return {
            Action: 'action',
            Entity: 'entity',
            ServiceApi: 'service_api',
            ServiceInternal: 'service_impl',
            ServiceImpl: 'service_impl',
            Rest: 'rest',
            Job: 'job'
        }[fileKind] || '';
    }

    _missingTemplateVariables(template = '', values = {}) {
        const vars = this._templateVariables(template);
        return vars.filter(key => !String(values[key] || '').trim());
    }

    _templateVariables(template = '') {
        const matches = String(template || '').match(/\{([^}]+)\}/gu) || [];
        return Array.from(new Set(matches.map(item => item.slice(1, -1))));
    }

    _acceptanceRefs(module = {}) {
        const refs = [];
        const ac = module.acceptanceCriteria;
        if (Array.isArray(ac)) {
            ac.forEach((item, index) => refs.push(item && item.code ? item.code : `${this._moduleId(module)}-AC${index + 1}`));
        } else if (ac && typeof ac === 'object') {
            ['happyPath', 'exception', 'boundary'].forEach(group => {
                const arr = Array.isArray(ac[group]) ? ac[group] : [];
                arr.forEach((item, index) => refs.push(item && item.code ? item.code : `${this._moduleId(module)}-${group}-${index + 1}`));
            });
        }
        return refs;
    }

    _firstAcceptanceText(module = {}, group = '') {
        const ac = module.acceptanceCriteria;
        if (Array.isArray(ac)) {
            const item = ac[0];
            return item && typeof item === 'object' ? String(item.description || item.scenario || '').trim() : String(item || '').trim();
        }
        const arr = ac && Array.isArray(ac[group]) ? ac[group] : [];
        const item = arr[0];
        if (!item) return '';
        return typeof item === 'object'
            ? [item.scenario, item.when, item.then].filter(Boolean).join(' / ')
            : String(item || '').trim();
    }

    _extractVersionBucket(frameworkBucket = {}) {
        return this._extractFrameworkContext(frameworkBucket).versionBucket;
    }

    _extractFrameworkContext(frameworkBucket = {}) {
        const evidence = frameworkBucket && frameworkBucket.evidence && typeof frameworkBucket.evidence === 'object'
            ? frameworkBucket.evidence
            : {};
        const frameworkVersionEvidence = frameworkBucket && frameworkBucket.frameworkVersionEvidence && typeof frameworkBucket.frameworkVersionEvidence === 'object'
            ? frameworkBucket.frameworkVersionEvidence
            : {};
        const nested = frameworkBucket && frameworkBucket.frameworkBucket && typeof frameworkBucket.frameworkBucket === 'object'
            ? frameworkBucket.frameworkBucket
            : {};
        return {
            versionBucket: String(
                frameworkBucket.versionBucket ||
                frameworkBucket.bucket ||
                nested.versionBucket ||
                nested.bucket ||
                ''
            ).trim(),
            frameworkVersion: String(
                frameworkBucket.frameworkVersion ||
                frameworkBucket.frameVersion ||
                frameworkBucket.projectContextFrameVersion ||
                evidence.version ||
                frameworkVersionEvidence.version ||
                ''
            ).trim()
        };
    }

    _pick(...values) {
        for (const value of values) {
            const text = String(value || '').trim();
            if (text) return text;
        }
        return '';
    }

    _normalizeStringList(...values) {
        const out = [];
        const seen = new Set();
        for (const value of values) {
            const list = Array.isArray(value) ? value : (typeof value === 'string' ? value.split(',') : []);
            for (const item of list) {
                const text = String(item || '').trim();
                if (!text || seen.has(text)) continue;
                seen.add(text);
                out.push(text);
            }
        }
        return out;
    }

    _normalizeRestContract(value = null) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const operations = (Array.isArray(value.operations) ? value.operations : [])
            .filter(item => item && typeof item === 'object' && !Array.isArray(item))
            .map(item => ({
                operationKey: String(item.operationKey || '').trim(),
                methodName: String(item.methodName || '').trim(),
                path: String(item.path || '').trim(),
                httpMethod: String(item.httpMethod || 'POST').trim().toUpperCase(),
                purpose: String(item.purpose || '').trim(),
                requestShape: String(item.requestShape || '').trim(),
                responseShape: String(item.responseShape || '').trim()
            }));
        const basePath = String(value.basePath || '').trim();
        if (!basePath && operations.length === 0) return null;
        return { basePath, operations };
    }

    _normalizeStatisticsContract(value = null) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const strip = (obj = {}) => {
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
        const normalizeObjects = list => (Array.isArray(list) ? list : [])
            .filter(item => item && typeof item === 'object' && !Array.isArray(item))
            .map(item => strip({ ...item }))
            .filter(item => Object.keys(item).length > 0);
        const contract = strip({
            title: String(value.title || '').trim(),
            purpose: String(value.purpose || '').trim(),
            dataSources: normalizeObjects(value.dataSources),
            filters: normalizeObjects(value.filters),
            dimensions: normalizeObjects(value.dimensions),
            metrics: normalizeObjects(value.metrics),
            display: value.display && typeof value.display === 'object' && !Array.isArray(value.display) ? strip({ ...value.display }) : undefined,
            ...(typeof value.exportRequired === 'boolean' ? { exportRequired: value.exportRequired } : {}),
            source: String(value.source || '').trim()
        });
        return Object.keys(contract).length > 0 ? contract : null;
    }

    _normalizeStatisticsContracts(value = [], fallback = null) {
        const out = [];
        const seen = new Set();
        const push = item => {
            const normalized = this._normalizeStatisticsContract(item);
            if (!normalized) return;
            const storyId = String(item && (item.storyId || item.sourceStoryId) || '').trim();
            const next = {
                ...(storyId ? { storyId, sourceStoryId: storyId } : {}),
                ...normalized
            };
            const key = `${storyId}::${JSON.stringify(this._stripStatisticsStoryRef(next))}`;
            if (seen.has(key)) return;
            seen.add(key);
            out.push(next);
        };
        if (Array.isArray(value)) {
            value.forEach(push);
        } else {
            push(value);
        }
        if (out.length === 0 && fallback) push(fallback);
        return out;
    }

    _stripStatisticsStoryRef(contract = {}) {
        if (!contract || typeof contract !== 'object' || Array.isArray(contract)) return contract;
        const { storyId, sourceStoryId, ...rest } = contract;
        return rest;
    }

    _normalizeWorkflowContract(value = null) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const strip = (obj = {}) => {
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
        const normalizeOperations = list => (Array.isArray(list) ? list : [])
            .map(item => {
                if (item && typeof item === 'object' && !Array.isArray(item)) {
                    return strip({
                        key: String(item.key || '').trim(),
                        name: String(item.name || '').trim(),
                        type: String(item.type || '').trim()
                    });
                }
                const text = String(item || '').trim();
                return text ? { name: text } : {};
            })
            .filter(item => Object.keys(item).length > 0);
        const activities = (Array.isArray(value.activities) ? value.activities : [])
            .filter(item => item && typeof item === 'object' && !Array.isArray(item))
            .map(item => strip({
                key: String(item.key || '').trim(),
                name: String(item.name || '').trim(),
                actor: String(item.actor || '').trim(),
                type: String(item.type || '').trim(),
                operations: normalizeOperations(item.operations)
            }))
            .filter(item => Object.keys(item).length > 0);
        const transitions = (Array.isArray(value.transitions) ? value.transitions : [])
            .filter(item => item && typeof item === 'object' && !Array.isArray(item))
            .map(item => strip({
                from: String(item.from || '').trim(),
                to: String(item.to || '').trim(),
                condition: String(item.condition || '').trim()
            }))
            .filter(item => Object.keys(item).length > 0);
        const businessResults = (Array.isArray(value.businessResults) ? value.businessResults : [])
            .map(item => String(item || '').trim())
            .filter(Boolean);
        const normalizeParameters = (items = []) => (Array.isArray(items) ? items : [])
            .filter(item => item && typeof item === 'object' && !Array.isArray(item))
            .map(item => strip({
                name: String(item.name || '').trim(),
                source: String(item.source || '').trim(),
                value: String(item.value || '').trim(),
                description: String(item.description || '').trim()
            }))
            .filter(item => Object.keys(item).length > 0);
        const operationEvents = (Array.isArray(value.operationEvents) ? value.operationEvents : [])
            .filter(item => item && typeof item === 'object' && !Array.isArray(item))
            .map(item => strip({
                storyId: String(item.storyId || '').trim().toUpperCase(),
                operationKey: String(item.operationKey || '').trim(),
                activityKey: String(item.activityKey || '').trim(),
                activityName: String(item.activityName || '').trim(),
                operationName: String(item.operationName || '').trim(),
                semantic: String(item.semantic || '').trim().toLowerCase(),
                mode: String(item.mode || '').trim().toLowerCase(),
                methodName: String(item.methodName || '').trim(),
                businessEffect: String(item.businessEffect || '').trim(),
                parameters: normalizeParameters(item.parameters)
            }))
            .filter(item => Object.keys(item).length > 0);
        const workflowExternalMethodSeeds = (Array.isArray(value.workflowExternalMethodSeeds) ? value.workflowExternalMethodSeeds : [])
            .filter(item => item && typeof item === 'object' && !Array.isArray(item))
            .map(item => strip({
                storyId: String(item.storyId || '').trim().toUpperCase(),
                operationKey: String(item.operationKey || '').trim(),
                activityName: String(item.activityName || '').trim(),
                operationName: String(item.operationName || '').trim(),
                methodName: String(item.methodName || '').trim(),
                businessEffect: String(item.businessEffect || '').trim(),
                parameters: normalizeParameters(item.parameters)
            }))
            .filter(item => Object.keys(item).length > 0);
        const contract = strip({
            processName: String(value.processName || '').trim(),
            starter: String(value.starter || '').trim(),
            activities,
            transitions,
            businessResults,
            ...(operationEvents.length > 0 ? { operationEvents } : {}),
            ...(workflowExternalMethodSeeds.length > 0 ? { workflowExternalMethodSeeds } : {}),
            pageSet: String(value.pageSet || 'workflow_minimal').trim() || 'workflow_minimal',
            source: String(value.source || '').trim()
        });
        return Object.keys(contract).length > 0 ? contract : null;
    }

    _normalizeWorkflowContracts(value = [], fallback = null) {
        const out = [];
        const seen = new Set();
        const push = item => {
            const normalized = this._normalizeWorkflowContract(item);
            if (!normalized) return;
            const storyId = String(item && (item.storyId || item.sourceStoryId) || '').trim();
            const next = {
                ...(storyId ? { storyId, sourceStoryId: storyId } : {}),
                ...normalized
            };
            const key = `${storyId}::${JSON.stringify(this._stripWorkflowStoryRef(next))}`;
            if (seen.has(key)) return;
            seen.add(key);
            out.push(next);
        };
        if (Array.isArray(value)) {
            value.forEach(push);
        } else {
            push(value);
        }
        if (out.length === 0 && fallback) push(fallback);
        return out;
    }

    _stripWorkflowStoryRef(contract = {}) {
        if (!contract || typeof contract !== 'object' || Array.isArray(contract)) return contract;
        const { storyId, sourceStoryId, ...rest } = contract;
        return rest;
    }

    _moduleId(module = {}) {
        return String(module.moduleId || module.id || '').trim();
    }

    _applyTemplate(template = '', values = {}) {
        return String(template || '').replace(/\{([^}]+)\}/gu, (match, key) => {
            return Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match;
        });
    }

    _hasUnresolvedPlaceholder(value = '') {
        return /\{[^}]+\}/u.test(String(value || ''));
    }

    _upperFirst(value = '') {
        const text = String(value || '').trim();
        return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
    }

    _subTypeLiteral(value = '') {
        const text = String(value || '').trim().toLowerCase();
        if (text === 'mylist') return 'MyList';
        if (text === 'workflow') return 'WorkFlow';
        return this._upperFirst(text);
    }

    _normalizeSlash(value = '') {
        return String(value || '').replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    }

    _md(value = '') {
        return String(value == null ? '' : value)
            .replace(/\r?\n/gu, '<br>')
            .replace(/\|/gu, '\\|');
    }

    _sha256(content = '') {
        const crypto = require('crypto');
        return crypto.createHash('sha256').update(String(content || ''), 'utf-8').digest('hex');
    }

    _blocked(errorCode, message, extra = {}) {
        return {
            ok: false,
            status: 'blocked',
            actionMode: 'upstream_design_repair',
            errorCode,
            message,
            allowedNextActions: ['repair_design_document_json', 'rerun_design_tdd_build_plan'],
            forbiddenNextActions: ['file_search', 'list_directory', 'write_design_tdd_plan_directly', 'continue_design_tdd_without_plan'],
            ...extra
        };
    }
}

module.exports = DesignTddPlanService;
