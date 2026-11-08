/* eslint-disable */
const fs = require('fs');
const path = require('path');

const GateContractRegistry = require('./gate-contract-registry');
const SkeletonGeneratorService = require('./skeleton-generator-service');
const DesignTddProgressBoardService = require('./design-tdd-progress-board-service');
const DesignTddRuleUsageHintService = require('./design-tdd-rule-usage-hint-service');
const CoderReuseCardService = require('./coder-reuse-card-service');
const CoderCompanyPracticeCardService = require('./coder-company-practice-card-service');
const TechStackGuardService = require('./design-tdd-code-style-guard-service');
const DesignTddWorkSliceService = require('./design-tdd-work-slice-service');
const resolveSkeletonSectionKey = require('./skeleton-section-key');
const {
    flattenBusinessFactsAcceptanceItems,
    flattenAcceptanceItems,
    getAcceptanceGroups
} = require('./design-tdd-acceptance-utils');

function buildReuseHint(options = {}) {
    const targetFile = String(options.targetFile || '').trim();
    const relatedFiles = Array.isArray(options.relatedFiles) ? options.relatedFiles : [];
    const existingFiles = Array.from(new Set([targetFile, ...relatedFiles].filter(Boolean)));
    const existingMethodHints = [];
    if (targetFile) {
        existingMethodHints.push({
            file: targetFile,
            methodName: '',
            reason: '先判断当前骨架文件是否已有可直接补逻辑的入口/方法，优先在原位补业务代码。'
        });
    }
    return {
        preferredStrategy: 'reuse_existing_first',
        existingFiles,
        existingMethodHints,
        decisionRule: '先判断现有文件/方法能否直接承载本条 Story 验收项；只有现有入口无法承载时，才允许新增方法。'
    };
}

function buildSingleMaterializeStepContract() {
    return {
        actionMode: 'display_then_call_single_tool',
        singleStepOnly: true,
        allowedNextActions: [
            'display_displayLine_then_call_toolCall_once',
            'display_displayLine_then_call_callTemplate_once'
        ],
        forbiddenActions: [
            'batch_materialize_remaining_files',
            'call_multiple_materialize_without_displayLine',
            'skip_displayLine_before_callTemplate'
        ]
    };
}

function buildMcpToolCall(toolName, args = {}) {
    return {
        mcpServer: 'epoint-project-rules',
        via: 'run_mcp',
        toolName,
        arguments: args,
        instruction: `按 arguments 原样调用 ${toolName} 一次；不要搜索、不要读文件、不要判断工具不可用。`
    };
}

function uniqueNonEmptyStrings(values = []) {
    const out = [];
    const seen = new Set();
    for (const value of (Array.isArray(values) ? values : [])) {
        const text = String(value || '').trim();
        if (!text || seen.has(text)) continue;
        seen.add(text);
        out.push(text);
    }
    return out;
}

class DesignTddSkeletonService {
    constructor(options = {}) {
        this.ruleService = options.ruleService || null;
        this.rulesPath = options.rulesPath || '';
        this.skeletonService = options.skeletonService || new SkeletonGeneratorService({
            ruleService: this.ruleService,
            rulesPath: this.rulesPath,
            pythonCommand: options.pythonCommand,
            scriptPath: options.scriptPath
        });
        this.progressBoardService = options.progressBoardService || new DesignTddProgressBoardService();
        this.ruleUsageHintService = options.ruleUsageHintService || new DesignTddRuleUsageHintService();
        this.reuseCardService = options.reuseCardService || new CoderReuseCardService();
        this.companyPracticeCardService = options.companyPracticeCardService || new CoderCompanyPracticeCardService();
        this.workSliceService = options.workSliceService || new DesignTddWorkSliceService();
    }

    rebuildWorkProjection(args = {}) {
        const normalizedProject = path.resolve(String(args.projectPath || '').trim());
        if (!args.projectPath) {
            return this._blocked('DESIGN_TDD_WORK_PROJECTION_PROJECT_PATH_MISSING', '缺少projectPath，无法重建Coder施工投影。');
        }
        const businessFactsPath = this._resolveBusinessFactsPath(normalizedProject);
        const planJsonPath = this._resolvePlanJsonPath(normalizedProject);
        const facts = args.facts && typeof args.facts === 'object'
            ? args.facts
            : (businessFactsPath && fs.existsSync(businessFactsPath) ? this._readJson(businessFactsPath) : null);
        const planJson = args.plan && typeof args.plan === 'object'
            ? args.plan
            : (planJsonPath && fs.existsSync(planJsonPath) ? this._readJson(planJsonPath) : null);
        if (!businessFactsPath || !facts || !planJson) {
            return this._blocked(
                'DESIGN_TDD_WORK_PROJECTION_INPUT_MISSING',
                '缺少business-facts.json或design-tdd-plan.json，无法机械重建work-slices投影。'
            );
        }
        const requirementWorkPackage = this._buildRequirementWorkPackage({
            facts,
            planJson,
            businessFactsPath,
            normalizedProject
        });
        if (!requirementWorkPackage) {
            return this._blocked('DESIGN_TDD_WORK_PROJECTION_BUILD_FAILED', '无法从现有plan/facts构造Coder施工投影。');
        }
        const requirementWorkDraft = this._buildRequirementWorkDraft(requirementWorkPackage);
        const projection = this._writeRequirementWorkArtifacts({
            normalizedProject,
            requirementWorkDraft,
            requirementWorkPackage,
            modulesOwnerFiles: Array.isArray(planJson && planJson.modulesOwnerFiles) ? planJson.modulesOwnerFiles : [],
            modulePlans: Array.isArray(planJson && planJson.modulePlans) ? planJson.modulePlans : [],
            constructionBindings: Array.isArray(planJson && planJson.constructionBindings) ? planJson.constructionBindings : [],
            storyWorkPackages: Array.isArray(planJson && planJson.storyWorkPackages) ? planJson.storyWorkPackages : [],
            outputCodeDir: args.outputCodeDir
        });
        if (!projection || projection.written !== true || !projection.workSlicesIndexPath) {
            return this._blocked('DESIGN_TDD_WORK_PROJECTION_WRITE_FAILED', 'work-slices投影写盘失败。');
        }
        return {
            ok: true,
            status: 'projection_ready',
            ...projection
        };
    }

    materialize(args = {}) {
        const projectPath = String(args.projectPath || '').trim();
        const targetFile = String(args.targetFile || '').trim();
        const fileKind = String(args.fileKind || '').trim();
        let sectionKey = String(args.sectionKey || '').trim();
        const action = String(args.action || 'create').trim().toLowerCase();
        // AGENTS.md "确定事实不进 LLM 视野" 红线：substitutions 字段已废弃，
        // entityName/pageName 等占位符值是 Builder 从 plan.json.intentLocks/modulesOwnerFiles
        // 派生的确定事实，LLM 不该看也不该传。LLM 传过来的 args.substitutions 一律忽略。
        // {模块}/{项目}/{domain}/{bizModule} 由 _extractPlaceholdersFromTargetPath 从 targetFile 派生；
        // {EntityName}/{pagename} 由 design-tdd-plan.json 派生；{表名}/业务字段由 business-facts.json 派生。
        if (!projectPath) return this._blocked('DESIGN_TDD_SKELETON_PROJECT_PATH_MISSING', '缺少 projectPath。');
        if (!targetFile) return this._blocked('DESIGN_TDD_SKELETON_TARGET_FILE_MISSING', '缺少 targetFile。');
        if (!fileKind) return this._blocked('DESIGN_TDD_SKELETON_FILE_KIND_MISSING', '缺少 fileKind。');
        if (action !== 'create') {
            return this._blocked('DESIGN_TDD_SKELETON_ACTION_NOT_CREATE', 'design_tdd_skeleton_materialize 只允许 action=create。');
        }

        const mappings = GateContractRegistry.getSkeletonMappings ? GateContractRegistry.getSkeletonMappings() : {};
        const eligible = new Set((mappings.SKELETON_ELIGIBLE_FILE_KINDS || []).map(item => String(item || '').trim()));
        if (!eligible.has(fileKind)) {
            return this._blocked('DESIGN_TDD_SKELETON_FILE_KIND_UNSUPPORTED',
                `不支持的 fileKind=${fileKind}。本工具仅支持 ${Array.from(eligible).join('/')}。`);
        }

        const normalizedProject = path.resolve(projectPath);
        const normalizedTarget = path.resolve(targetFile);
        if (!this._isSameOrChild(normalizedTarget, normalizedProject)) {
            return this._blocked('DESIGN_TDD_SKELETON_TARGET_OUT_OF_PROJECT', `targetFile 不在 projectPath 内：${normalizedTarget}`);
        }
        if (fs.existsSync(normalizedTarget)) {
            if (!fs.statSync(normalizedTarget).isFile()) {
                return this._blocked('DESIGN_TDD_SKELETON_TARGET_NOT_FILE',
                    `目标位置不是源码文件，不能登记骨架完成：${normalizedTarget}`);
            }
            const ownerFile = this._findOwnerFileInPlan({
                normalizedProject,
                normalizedTarget,
                fileKind,
                moduleId: String(args.moduleId || '').trim()
            });
            if (ownerFile) {
                const existingResult = {
                    ok: true,
                    status: 'materialized_existing',
                    materializedFiles: [{
                        targetFile: normalizedTarget,
                        fileKind,
                        status: 'materialized_existing',
                        existingTarget: true,
                        sectionKey: String(ownerFile.sectionKey || sectionKey || '').trim(),
                        methodNames: [],
                        methodSignatures: []
                    }]
                };
                const moduleIdFromArgs = String(args.moduleId || '').trim();
                const nextActionCard = moduleIdFromArgs
                    ? this._buildNextActionCardAfterMaterialize({
                        normalizedProject,
                        moduleId: moduleIdFromArgs,
                        justMaterializedFileKind: fileKind,
                        justMaterializedTargetFile: normalizedTarget,
                        args
                    })
                    : null;
                return {
                    ...existingResult,
                    ...(nextActionCard ? { nextActionCard } : {}),
                    _audit: {
                        source: 'design_tdd_skeleton_materialize',
                        materializedFile: existingResult.materializedFiles[0],
                        scan: {
                            existingTarget: true
                        }
                    }
                };
            }
            return {
                ok: false,
                status: 'skipped',
                actionMode: 'consumer_module_skip_materialize',
                errorCode: 'DESIGN_TDD_SKELETON_TARGET_ALREADY_EXISTS',
                message: `targetFile 已存在：${normalizedTarget}。同聚合根（同 entityName+bizModule+fileKind）的物理文件只由 owner 模块物化一次，其它模块作为 consumer 直接消费。本模块若是 consumer → 跳过本次 materialize，进入整需求业务实现；若是 owner 但文件已存在 → 上游模块顺序错或人工建过，先排查工程目录。**不要删文件重物化**。`
            };
        }

        const scanDir = path.join(normalizedProject, '.ai-workspace', 'project');
        const navigationContractPath = path.resolve(String(args.navigationContractPath || path.join(scanDir, '工程导航契约.json')).trim());
        const frameworkBucketPath = path.resolve(String(args.frameworkBucketPath || path.join(scanDir, '框架版本档位.json')).trim());
        if (!fs.existsSync(navigationContractPath)) {
            return this._blocked('DESIGN_TDD_SCAN_NAVIGATION_CONTRACT_MISSING', `缺少 scan 产物：${navigationContractPath}`);
        }
        if (!fs.existsSync(frameworkBucketPath)) {
            return this._blocked('DESIGN_TDD_SCAN_FRAMEWORK_BUCKET_MISSING', `缺少 scan 产物：${frameworkBucketPath}`);
        }

        const navigationContract = this._readJson(navigationContractPath);
        if (!navigationContract) {
            return this._blocked('DESIGN_TDD_SCAN_NAVIGATION_CONTRACT_INVALID', `工程导航契约无法解析：${navigationContractPath}`);
        }
        const frameworkBucket = this._readJson(frameworkBucketPath);
        if (!frameworkBucket) {
            return this._blocked('DESIGN_TDD_SCAN_FRAMEWORK_BUCKET_INVALID', `框架版本档位无法解析：${frameworkBucketPath}`);
        }
        const scanVersionBucket = this._extractVersionBucket(frameworkBucket);
        const scanFramework = String(frameworkBucket.framework || frameworkBucket.frameworkName || '').trim();
        if (!scanVersionBucket) {
            return this._blocked('DESIGN_TDD_SCAN_VERSION_BUCKET_MISSING', '框架版本档位.json 缺少 versionBucket。');
        }
        const requestedBucket = String(args.versionBucket || '').trim();
        if (requestedBucket && requestedBucket !== scanVersionBucket) {
            return this._blocked('DESIGN_TDD_SKELETON_VERSION_BUCKET_MISMATCH',
                `versionBucket 必须来自 scan。scan=${scanVersionBucket}, actual=${requestedBucket}`);
        }

        const targetMatch = this._targetMatchesNavigationContract(normalizedTarget, normalizedProject, navigationContract, fileKind);
        if (!targetMatch.ok) {
            return this._blocked(targetMatch.errorCode, targetMatch.message, {
                navigationContractPath,
                fileKind,
                targetFile: normalizedTarget
            });
        }

        sectionKey = this._resolveSectionKeyForMaterialize({
            explicitSectionKey: sectionKey,
            normalizedProject,
            normalizedTarget,
            fileKind,
            moduleId: String(args.moduleId || '').trim()
        });
        if (!sectionKey) {
            return this._blocked('DESIGN_TDD_SKELETON_SECTION_KEY_UNRESOLVED',
                '无法从 design-tdd-plan.json 派生规则模板章节。请先重跑 design_tdd_build_plan 刷新 plan，确认 targetFile 在当前模块 ownerFiles 中。');
        }

        const dependencyCheck = this._validateSkeletonDependencyBindings({
            normalizedProject,
            normalizedTarget,
            fileKind
        });
        if (!dependencyCheck.ok) return dependencyCheck;

        // P3.2 关键修复（2026-05）：从 targetFile + scan 模板反解路径段占位符（{项目} {domain} {bizModule}/{模块}），
        // 由 Builder 汇总进内部 substitutions。LLM 不传这些确定事实，也不让骨架里残留字面占位符。
        // 占位符值是从 scan 真值（targetFile 路径）派生的确定事实，LLM 不应该决定也不应该看到。
        const scanDerivedSubstitutions = this._extractPlaceholdersFromTargetPath(
            normalizedTarget,
            normalizedProject,
            targetMatch.template
        );

        // AGENTS.md "确定事实不进 LLM 视野" 红线：
        //   {EntityName} / {pagename} 等业务命名占位符的值都已在 plan.json 里
        //   （intentLocks[moduleId].businessContext.entityName / pageName 由 Builder 派生）。
        //   LLM 不该传 substitutions —— 之前让 LLM 传是因为它从 callTemplate 抄一遍，
        //   实战 trace 显示 LLM 经常漏传或传错（凭印象塞 {bizModule}/{domain}），导致
        //   占位符未替换，生成残次品。
        //
        // 修法：Builder 在 materialize 入口直接从 plan.json 派生 builder-owned substitutions；
        // args.substitutions 已废弃，真实工具链不再读取，缺 plan 产物由 MCP 前置门禁 blocked。
        const builderOwnedSubstitutions = this._derivePlanSubstitutions(
            normalizedProject,
            String(args.moduleId || '').trim(),
            fileKind,
            normalizedTarget
        );

        const substitutions = {};
        // 1) scan 派生（基础真值：{模块}/{module}/{项目}/{project}）
        for (const [key, value] of Object.entries(scanDerivedSubstitutions || {})) {
            substitutions[key] = String(value || '');
        }
        // 2) Builder 从 plan.json 派生（业务命名：{EntityName}/{pagename}）
        //    这是确定事实，覆盖 scan 派生（极端情况 scan 撞名时让 plan 真值优先）
        for (const [key, value] of Object.entries(builderOwnedSubstitutions || {})) {
            substitutions[key] = String(value || '');
        }

        // P4 fileKind 后处理：把 moduleId + business-facts.json 路径也透传给 Python，
        // 让 Builder 把"机械映射的代码"自动展开（Entity 业务字段 / ServiceImpl 转发等）。
        // 路径推导：<demandDir>/code/business-facts.json
        const moduleIdForPostFill = String(args.moduleId || '').trim();
        let businessFactsPath = '';
        try {
            const projectArtifactsDir = path.join(normalizedProject, '.ai-workspace', 'project');
            const activeDemandPath = path.join(projectArtifactsDir, '.active-demand');
            if (fs.existsSync(activeDemandPath)) {
                const demandName = String(fs.readFileSync(activeDemandPath, 'utf-8') || '').trim();
                if (demandName) {
                    const candidate = path.join(projectArtifactsDir, demandName, 'code', 'business-facts.json');
                    if (fs.existsSync(candidate)) businessFactsPath = candidate;
                }
            }
        } catch (_) {
            // business-facts.json 路径用于 Python 端按需取字段；MCP 入口已要求 build_plan 先落盘。
        }

        const result = this.skeletonService.strictMaterialize({
            projectPath: normalizedProject,
            targetFile: normalizedTarget,
            ruleAlias: args.ruleAlias,
            ruleFilePath: args.ruleFilePath,
            rulesBaseDir: args.rulesBaseDir,
            sectionKey,
            fileKind,
            action: 'create',
            framework: String(args.framework || scanFramework || '').trim(),
            versionBucket: scanVersionBucket,
            substitutions,
            moduleId: moduleIdForPostFill,
            businessFactsPath,
            outputDir: args.outputDir || path.dirname(normalizedTarget),
            timeoutMs: args.timeoutMs
        });
        if (result && result.ok === true) {
            this._normalizeGeneratedRouteBinding({
                normalizedProject,
                moduleId: moduleIdForPostFill,
                normalizedTarget,
                fileKind
            });
        }

        const slimResult = this._slimMaterializeResult(result);
        const blockedFallback = this._buildBuiltinContextMissingBlockedResult(result, {
            projectPath: normalizedProject,
            moduleId: moduleIdForPostFill,
            targetFile: normalizedTarget,
            fileKind,
            sectionKey
        });
        if (blockedFallback) {
            return blockedFallback;
        }
        const moduleIdFromArgs = String(args.moduleId || '').trim();

        // s2c 范式 nextActionCard：物化成功后告诉 LLM"本模块还差哪个 owner 文件 / 都齐了→进入整需求业务实现"
        // 故事线：截图里 LLM 漏物化 ServiceInternal 是因为没读 plan.md，凭训练记忆里"4 件套"开始物化。
        // 修法：每次物化成功都返回下一个 owner 文件的 callTemplate，LLM 复制粘贴即可，不会漏。
        const nextActionCard = (slimResult.ok && moduleIdFromArgs)
            ? this._buildNextActionCardAfterMaterialize({
                normalizedProject,
                moduleId: moduleIdFromArgs,
                justMaterializedFileKind: fileKind,
                justMaterializedTargetFile: normalizedTarget,
                args
            })
            : null;

        return {
            ...slimResult,
            ...(nextActionCard ? { nextActionCard } : {}),
            // _audit 字段以下划线开头，约定为"内部审计字段"：
            // - mcp 入口在返回 LLM 前读取 materializedFile 写入需求级 ledger
            // - mcp 入口必须在返回 LLM 前删掉这个字段，避免污染上下文
            // - 主返回不含此字段（LLM 上下文压缩后看不到，徒占注意力）
            _audit: {
                source: 'design_tdd_skeleton_materialize',
                materializedFile: Array.isArray(result.materializedFiles) && result.materializedFiles[0]
                    ? result.materializedFiles[0]
                    : null,
                scan: {
                    navigationContractPath,
                    frameworkBucketPath,
                    framework: scanFramework,
                    matchedPathKey: targetMatch.pathKey,
                    matchedTemplate: targetMatch.template
                }
            }
        };
    }

    /**
     * s2c "下一步即拉即给"动作卡：物化成功后告诉 LLM 下一动作。
     *
     * 三种场景：
     *   ① 本模块还有 owner 文件没物化 → 返回下一个 owner 文件的 materialize callTemplate
     *   ② 本模块全部 owner 文件已物化 → 返回整需求业务实现引导卡
     *   ③ plan.json 不可读 → 返回 null，不阻断主返回
     *
     * 故事线：截图里 LLM 物化完 Action 后没继续物化 ServiceInternal，因为它没意识到本模块
     * 还有 5 个 owner 文件（凭训练记忆里"4 件套"打止）。Builder 知道完整顺序，直接告诉 LLM。
     */
    _buildNextActionCardAfterMaterialize({ normalizedProject, moduleId, justMaterializedFileKind, justMaterializedTargetFile, args }) {
        try {
            const planJsonPath = this._resolvePlanJsonPath(normalizedProject);
            if (!planJsonPath || !fs.existsSync(planJsonPath)) return null;
            const planJson = JSON.parse(fs.readFileSync(planJsonPath, 'utf-8'));
            const allOwnerModules = this._getSkeletonOwnerModulesFromPlan(planJson, { includeEmpty: true });
            const moduleEntry = allOwnerModules.find(m => m.moduleId === moduleId);
            if (!moduleEntry || !Array.isArray(moduleEntry.ownerFiles)) return null;

            const ownerFiles = moduleEntry.ownerFiles;
            const justKind = String(justMaterializedFileKind || '').trim();
            // 4 Action 同 fileKind / 不同 subType 的场景：必须按 resolvedPath 唯一匹配，
            // 不能再用 fileKind 找索引（会一直命中第一个 ListAction，导致 Add/Edit/Detail 跳过物化）。
            const justTargetNormalized = this._normalizePlanTargetPath(justMaterializedTargetFile, normalizedProject);
            let idx = -1;
            if (justTargetNormalized) {
                idx = ownerFiles.findIndex(f => this._normalizePlanTargetPath(f && f.resolvedPath, normalizedProject) === justTargetNormalized);
            }
            if (idx < 0) {
                idx = ownerFiles.findIndex(f => f.fileKind === justKind);
            }
            const remaining = idx >= 0 ? ownerFiles.slice(idx + 1) : ownerFiles;
            const totalOwner = ownerFiles.length;
            const completed = totalOwner - remaining.length;
            // 注意力治理（AGENTS.md "保护 LLM 注意力" + "nextActionCard 高信号治理"）：
            // 物化串行阶段的卡只承载"继续物化下一个骨架"这一个动作，不再挂 reuseHint /
            // requiredThinking——那是"写业务代码前"的复用/施工思考，属于施工阶段材料。
            // 真正写业务代码需要的复用判断、候选文件、公司实践、自检卡已在
            // requirement-work-draft.json 里；放在物化阶段只会重复塞阶段外材料、
            // 诱导 LLM 提前读复用/想业务，和"单步物化、不批量、不提前施工"目标冲突。

            // A. 进度看板打勾 — Builder 自治（不让 LLM 调）
            //   - 单文件物化完：骨架列改 IN_PROGRESS（除非这是第 1 个）
            //   - 6 件套全完：骨架列改 DONE
            // 故事线：用户实测发现 plan.md 进度看板从头到尾 ⬜⬜⬜⬜，没人更新。
            // 之前注释里写"LLM 在双写时通过 markCell 动态打勾"——指望 LLM 主动调，结果 LLM 当然不调。
            // 修法：Builder 在每次物化后自动 markCell，进度对用户和 LLM 实时可见。
            this._updateProgressBoardOnMaterialize(normalizedProject, moduleId, remaining.length === 0);

            if (remaining.length === 0) {
                // 本模块所有 owner 文件物化完毕 — 检查全局是否还有其它模块未物化。
                // 故事线：之前每个模块完都进单条验收项核对，但验收项涉及的文件可能在其它模块（如 MOD-01
                // 的列表查询用的 list.html 在 MOD-05 还没物化），LLM 没法核对。
                // 修法：本模块全完时检查 plan.json 的 Builder 调度视图全局——还有未物化模块串到下一个，
                // 全部模块全完才进入 Story 需求施工包。优先读 skeletonComposition，缺失时回退 modulesOwnerFiles。
                const scheduledOwnerModules = this._getSkeletonOwnerModulesFromPlan(planJson);
                const currentIdx = scheduledOwnerModules.findIndex(m => m.moduleId === moduleId);
                const nextModule = currentIdx >= 0 && currentIdx + 1 < scheduledOwnerModules.length
                    ? scheduledOwnerModules[currentIdx + 1]
                    : null;

                if (nextModule && Array.isArray(nextModule.ownerFiles) && nextModule.ownerFiles.length > 0) {
                    // 还有下一模块未物化 — 串到该模块第一个 owner 文件
                    const firstOwner = nextModule.ownerFiles[0];
                    const skeletonUnit = this._buildSkeletonUnitSummary(firstOwner);
                    const inlineArgs = {
                        projectPath: String(args && args.projectPath || ''),
                        skillName: 'epoint-design-tdd-coder',
                        moduleId: nextModule.moduleId,
                        fileKind: firstOwner.fileKind,
                        targetFile: firstOwner.resolvedPath
                    };
                    const totalNextOwner = nextModule.ownerFiles.length;
                    const displayLine = `✅ ${moduleId} 骨架完成 → ▶ 切换到 ${nextModule.moduleId} 物化中 1/${totalNextOwner}：${firstOwner.fileKind} (${path.basename(firstOwner.resolvedPath)})`;
                    return {
                        title: `${moduleId} 骨架已就位，进入下一模块 ${nextModule.moduleId} 物化第一个 owner 文件`,
                        stopAfter: false,
                        displayLine,
                        displayRequired: true,
                        ...buildSingleMaterializeStepContract(),
                        instruction: '先输出 displayLine，再按 toolCall.arguments 调一次 design_tdd_skeleton_materialize；禁止读文件、搜索、批量物化或补业务代码。',
                        purpose: `开始物化下一模块 ${nextModule.moduleId}`,
                        toolCall: buildMcpToolCall('design_tdd_skeleton_materialize', inlineArgs),
                        callTemplate: `design_tdd_skeleton_materialize(${JSON.stringify(inlineArgs)})`,
                        ...(skeletonUnit ? { skeletonUnit } : {}),
                        afterAllOwnerFilesMaterializedSeeNextActionCard: true
                    };
                }

                // 全局所有模块物化完毕 → 优先引导 User Story 需求施工包
                // 故事线：骨架全齐才进需求施工，避免验收项涉及的文件还没物化导致核对中断。
                return this._buildAcceptanceChecklistCard({
                    normalizedProject,
                    moduleId,
                    args,
                    moduleOwnerFilesCompleted: ownerFiles.map(f => ({ fileKind: f.fileKind, resolvedPath: f.resolvedPath }))
                });
            }

            // 还有 owner 文件 → 给下一个的 callTemplate
            // AGENTS.md "确定事实不进 LLM 视野"：substitutions 字段已废弃，
            // Builder 在 materialize 入口直接从 plan.json 派生 {EntityName}/{pagename}，
            // LLM 不需要也不应该再传 substitutions。callTemplate 不再带这个字段。
            const next = remaining[0];
            const skeletonUnit = this._buildSkeletonUnitSummary(next);
            const inlineArgs = {
                projectPath: String(args && args.projectPath || ''),
                skillName: 'epoint-design-tdd-coder',
                moduleId,
                fileKind: next.fileKind,
                targetFile: next.resolvedPath
            };

            // C. displayLine — 调 callTemplate 之前，LLM 必须先把这一行原样输出给用户
            //   作用：每个工具调用之间给用户一句"我在干什么"的状态。
            //   不让 LLM 凭印象写中间报告（容易跑题），直接给文本让它复读。
            const displayLine = `▶ ${moduleId} 物化中 ${completed + 1}/${totalOwner}：${next.fileKind} (${path.basename(next.resolvedPath)})`;

            return {
                title: `${moduleId} 下一步物化 ${next.fileKind}`,
                stopAfter: false,
                displayLine,
                displayRequired: true,
                ...buildSingleMaterializeStepContract(),
                instruction: '先输出 displayLine，再按 toolCall.arguments 调一次 design_tdd_skeleton_materialize；禁止读文件、搜索、批量物化或补业务代码。',
                purpose: `物化 ${moduleId} 第 ${completed + 1}/${totalOwner} 个 owner 文件`,
                toolCall: buildMcpToolCall('design_tdd_skeleton_materialize', inlineArgs),
                callTemplate: `design_tdd_skeleton_materialize(${JSON.stringify(inlineArgs)})`,
                ...(skeletonUnit ? { skeletonUnit } : {}),
                afterAllOwnerFilesMaterializedSeeNextActionCard: true
            };
        } catch (_) {
            return null;
        }
    }

    _getSkeletonOwnerModulesFromPlan(planJson = {}, options = {}) {
        const includeEmpty = options && options.includeEmpty === true;
        const fromComposition = this._ownerModulesFromSkeletonComposition(planJson && planJson.skeletonComposition);
        const modulesById = new Map();
        fromComposition.forEach(moduleEntry => {
            if (moduleEntry && moduleEntry.moduleId) modulesById.set(moduleEntry.moduleId, moduleEntry);
        });
        const fallbackModules = (Array.isArray(planJson && planJson.modulesOwnerFiles) ? planJson.modulesOwnerFiles : [])
            .filter(m => Array.isArray(m && m.ownerFiles) && m.ownerFiles.length > 0)
            .map(m => ({
                moduleId: String(m && m.moduleId || '').trim(),
                businessContext: m && m.businessContext || {},
                ownerFiles: Array.isArray(m && m.ownerFiles) ? m.ownerFiles : []
            }))
            .filter(m => m.moduleId && m.ownerFiles.length > 0);
        fallbackModules.forEach(moduleEntry => {
            if (!modulesById.has(moduleEntry.moduleId)) modulesById.set(moduleEntry.moduleId, moduleEntry);
        });
        if (includeEmpty) {
            for (const rawModule of (Array.isArray(planJson && planJson.modulesOwnerFiles) ? planJson.modulesOwnerFiles : [])) {
                const moduleId = String(rawModule && rawModule.moduleId || '').trim();
                if (!moduleId || modulesById.has(moduleId)) continue;
                modulesById.set(moduleId, {
                    moduleId,
                    businessContext: rawModule && rawModule.businessContext || {},
                    ownerFiles: Array.isArray(rawModule && rawModule.ownerFiles) ? rawModule.ownerFiles : []
                });
            }
        }
        const modules = Array.from(modulesById.values());
        return includeEmpty ? modules.filter(m => m.moduleId) : modules.filter(m => m.moduleId && m.ownerFiles.length > 0);
    }

    _ownerModulesFromSkeletonComposition(composition = {}) {
        const modules = [];
        const rawModules = Array.isArray(composition && composition.modules) ? composition.modules : [];
        for (const moduleEntry of rawModules) {
            const moduleId = String(moduleEntry && moduleEntry.moduleId || '').trim();
            const units = Array.isArray(moduleEntry && moduleEntry.units) ? moduleEntry.units : [];
            if (!moduleId || units.length === 0) continue;
            const ownerFiles = [];
            for (const unit of units) {
                const unitMeta = {
                    unitId: String(unit && unit.unitId || '').trim(),
                    unitType: String(unit && unit.unitType || '').trim(),
                    subType: String(unit && unit.subType || '').trim(),
                    materializeMode: String(unit && unit.materializeMode || '').trim(),
                    displayName: String(unit && unit.displayName || '').trim()
                };
                for (const file of (Array.isArray(unit && unit.files) ? unit.files : [])) {
                    const fileKind = String(file && file.fileKind || '').trim();
                    const resolvedPath = String(file && file.resolvedPath || '').trim();
                    if (!fileKind || !resolvedPath) continue;
                    ownerFiles.push({
                        ...file,
                        fileKind,
                        resolvedPath,
                        subType: file.subType || unitMeta.subType,
                        operation: file.operation || 'create',
                        evidenceRef: file.evidenceRef || moduleId,
                        _skeletonUnit: unitMeta
                    });
                }
            }
            if (ownerFiles.length > 0) {
                modules.push({
                    moduleId,
                    businessContext: moduleEntry.businessContext || {},
                    ownerFiles
                });
            }
        }
        return modules;
    }

    _buildSkeletonUnitSummary(ownerFile = {}) {
        const unit = ownerFile && ownerFile._skeletonUnit;
        if (!unit || !unit.unitType) return null;
        return {
            unitId: unit.unitId || '',
            unitType: unit.unitType || '',
            ...(unit.subType ? { subType: unit.subType } : {}),
            ...(unit.materializeMode ? { materializeMode: unit.materializeMode } : {}),
            ...(unit.displayName ? { displayName: unit.displayName } : {})
        };
    }

    /**
     * 每次物化成功后，自动更新 design-tdd-plan.md 进度看板的"骨架"列。
     *
     * 故事线：plan.md 进度看板由 progressBoardService.renderInitialBoard 渲染（含 begin/end
     * 锚点），但之前没人在物化后调 markCell——指望 LLM 主动调，结果用户实测看到从头到尾
     * ⬜⬜⬜⬜ 一格未动，体感是黑盒。
     *
     * Builder 自治原则：进度刷新是确定事实（"6 件套都物化完 = 骨架列 DONE"），LLM 不该
     * 决定也不该看到。Builder 自己 markCell，文件即时刷新。
     *
     * @param {string} normalizedProject 项目根
     * @param {string} moduleId 当前模块
     * @param {boolean} allOwnerFilesDone 6 件套是否全部物化完
     */
    _updateProgressBoardOnMaterialize(normalizedProject, moduleId, allOwnerFilesDone) {
        try {
            const planMdPath = this._resolvePlanMarkdownPath(normalizedProject);
            if (!planMdPath || !fs.existsSync(planMdPath)) return;
            const status = allOwnerFilesDone ? '✅' : '🟡';
            this.progressBoardService.markCell(planMdPath, moduleId, 'skeleton', status);
        } catch (_) {
            // 进度看板更新失败不阻断 materialize 主链路；ledger 里仍有 manifest 审计依据
        }
    }

    /**
     * 由 normalizedProject + .active-demand 推 design-tdd-plan.md 的固定路径（与 .json 同目录）。
     */
    _resolvePlanMarkdownPath(normalizedProject) {
        try {
            const projectArtifactsDir = path.join(normalizedProject, '.ai-workspace', 'project');
            const activeDemandPath = path.join(projectArtifactsDir, '.active-demand');
            if (!fs.existsSync(activeDemandPath)) return '';
            const demandName = String(fs.readFileSync(activeDemandPath, 'utf-8') || '').trim();
            if (!demandName) return '';
            return path.join(projectArtifactsDir, demandName, 'code', 'design-tdd-plan.md');
        } catch (_) {
            return '';
        }
    }

    /**
     * 由 normalizedProject + .active-demand 推 design-tdd-plan.json 的固定路径。
     * plan-service.buildPlan 会在 design-tdd-plan.md 同目录写一份 .json 副本。
     */
    _resolvePlanJsonPath(normalizedProject) {
        try {
            const projectArtifactsDir = path.join(normalizedProject, '.ai-workspace', 'project');
            const activeDemandPath = path.join(projectArtifactsDir, '.active-demand');
            if (!fs.existsSync(activeDemandPath)) return '';
            const demandName = String(fs.readFileSync(activeDemandPath, 'utf-8') || '').trim();
            if (!demandName) return '';
            return path.join(projectArtifactsDir, demandName, 'code', 'design-tdd-plan.json');
        } catch (_) {
            return '';
        }
    }

    /**
     * 从 plan.json 派生 builder-owned substitutions（{EntityName} / {pagename} / {FeatureName}）。
     *
     * 故事线：业务命名占位符的值都已在 plan.json 里（intentLocks[moduleId].businessContext
     * 由 build_plan Builder 从 designJson.codingHandoff 派生）。LLM 不该传 substitutions ——
     * 之前让 LLM 传是从 callTemplate 抄一遍，实战 trace 显示 LLM 经常漏传或传错（凭印象塞
     * {bizModule}/{domain}），导致占位符未替换，生成残次品。
     *
     * AGENTS.md "确定事实不进 LLM 视野" 红线：entityName/pageName 是 Builder 派生的确定事实，
     * Builder 自己派生即可，不让 LLM 参与。
     *
     * 关键修复（2026-05）：
     *   {pagename} 不再限制 fileKind === 'HtmlPage'。Action 模板的 @RestController("gxh{pagename}listaction")
     *   和 HtmlPage 的 epoint.initPage("gxh{pagename}listaction") 必须与最终 Action 类名同源。
     *   当 pageName 与 EntityName 不一致时，优先从最终 Action 类名反推 pagename，避免
     *   GxhRecordListAction 生成 @RestController("gxhreservelistaction") 这类错配。
     *
     * 失败容忍：plan.json 缺失 / 模块不在 plan / businessContext 缺字段时返回空对象，
     * 落到下游 unresolved placeholder，暴露上游产物缺口，不从文件名猜业务命名。
     */
    _derivePlanSubstitutions(normalizedProject, moduleId, fileKind, normalizedTarget = '') {
        const out = {};
        try {
            const planJsonPath = this._resolvePlanJsonPath(normalizedProject);
            if (planJsonPath && fs.existsSync(planJsonPath)) {
                const planJson = JSON.parse(fs.readFileSync(planJsonPath, 'utf-8'));
                // 优先从 modulesOwnerFiles[].businessContext 取（与 nextActionCard 派生一致）；
                // 兜底从 intentLocks[].businessContext 取（同源，build_plan 用同一份事实写入两处）
                const moduleEntry = (Array.isArray(planJson.modulesOwnerFiles) ? planJson.modulesOwnerFiles : [])
                    .find(m => m && m.moduleId === moduleId);
                let ctx = moduleEntry && moduleEntry.businessContext;
                if (!ctx) {
                    const lock = (Array.isArray(planJson.intentLocks) ? planJson.intentLocks : [])
                        .find(l => l && l.moduleId === moduleId);
                    ctx = lock && lock.businessContext;
                }
                if (ctx) {
                    if (ctx.entityName) out['{EntityName}'] = String(ctx.entityName);
                    if (ctx.featureName) out['{FeatureName}'] = String(ctx.featureName);
                    const actionRoutePageName = this._deriveActionRoutePageName({
                        planJson,
                        moduleEntry,
                        normalizedTarget,
                        fileKind
                    });
                    if (actionRoutePageName || ctx.pageName) out['{pagename}'] = String(actionRoutePageName || ctx.pageName);
                    if (ctx.bizModule) out['{module}'] = String(ctx.bizModule);
                    if (ctx.bizModule) out['{模块}'] = String(ctx.bizModule);
                    if (ctx.operationName) out['{OperationName}'] = String(ctx.operationName);
                    if (ctx.operationName) out['{operationName}'] = String(ctx.operationName);
                    if (fileKind === 'Rest' && ctx.restContract && typeof ctx.restContract === 'object') {
                        out['{RestContractJson}'] = JSON.stringify(ctx.restContract);
                        if (ctx.restContract.basePath) out['{RestBasePath}'] = String(ctx.restContract.basePath);
                        const firstOperation = Array.isArray(ctx.restContract.operations) ? ctx.restContract.operations[0] : null;
                        if (firstOperation && typeof firstOperation === 'object') {
                            if (firstOperation.methodName) out['{RestMethodName}'] = String(firstOperation.methodName);
                            if (firstOperation.path) out['{RestOperationPath}'] = String(firstOperation.path);
                            if (firstOperation.httpMethod) out['{RestHttpMethod}'] = String(firstOperation.httpMethod).toUpperCase();
                        }
                    }
                    if (ctx.workflowContract && typeof ctx.workflowContract === 'object') {
                        out['{WorkflowContractJson}'] = JSON.stringify(ctx.workflowContract);
                        if (ctx.workflowContract.processName) out['{WorkflowProcessName}'] = String(ctx.workflowContract.processName);
                        if (ctx.workflowContract.starter) out['{WorkflowStarter}'] = String(ctx.workflowContract.starter);
                    }
                    if (Array.isArray(ctx.workflowContracts) && ctx.workflowContracts.length > 0) {
                        out['{WorkflowContractsJson}'] = JSON.stringify(ctx.workflowContracts);
                        const firstWorkflow = ctx.workflowContracts.find(item => item && typeof item === 'object');
                        if (firstWorkflow && firstWorkflow.processName) out['{WorkflowProcessName}'] = String(firstWorkflow.processName);
                        if (firstWorkflow && firstWorkflow.starter) out['{WorkflowStarter}'] = String(firstWorkflow.starter);
                    }
                }
            }
        } catch (_) {
            // silent fallback
        }
        return out;
    }

    _deriveActionRoutePageName({ planJson = {}, moduleEntry = null, normalizedTarget = '', fileKind = '' } = {}) {
        const kind = String(fileKind || '').trim();
        if (kind === 'Action') {
            return this._routePageNameFromActionClassName(path.basename(String(normalizedTarget || ''), '.java'));
        }
        if (kind !== 'HtmlPage') return '';
        const subType = this._htmlSubTypeFromPath(normalizedTarget);
        if (!subType) return '';
        const ownerFiles = [
            ...(moduleEntry && Array.isArray(moduleEntry.ownerFiles) ? moduleEntry.ownerFiles : []),
            ...(Array.isArray(planJson.candidateFiles) ? planJson.candidateFiles : [])
        ];
        const matchedAction = ownerFiles.find(file => {
            if (String(file && file.fileKind || '').trim() !== 'Action') return false;
            const fileSubType = this._normalizeActionSubType(file && file.subType || this._subTypeFromActionFile(file && (file.resolvedPath || file.path || file.filePath)));
            return fileSubType === (subType === 'workflowdetail' ? 'workflow' : subType);
        });
        const actionPath = matchedAction && (matchedAction.resolvedPath || matchedAction.path || matchedAction.filePath);
        return this._routePageNameFromActionClassName(path.basename(String(actionPath || ''), '.java'));
    }

    _routePageNameFromActionClassName(className = '') {
        const lower = String(className || '').replace(/\.java$/iu, '').trim().toLowerCase();
        if (!lower) return '';
        for (const suffix of ['workflowaction', 'mylistaction', 'listaction', 'addaction', 'editaction', 'detailaction', 'action']) {
            if (!lower.endsWith(suffix)) continue;
            const withoutSuffix = lower.slice(0, -suffix.length);
            return withoutSuffix.startsWith('gxh') ? withoutSuffix.slice(3) : withoutSuffix;
        }
        return '';
    }

    _htmlSubTypeFromPath(filePath = '') {
        const base = path.basename(String(filePath || ''), path.extname(String(filePath || ''))).toLowerCase();
        if (!base) return '';
        for (const subType of ['workflowdetail', 'workflow', 'mylist', 'list', 'add', 'edit', 'detail']) {
            if (base.endsWith(subType)) return subType;
        }
        return '';
    }

    _subTypeFromActionFile(filePath = '') {
        const base = path.basename(String(filePath || ''), path.extname(String(filePath || ''))).toLowerCase();
        if (!base) return '';
        for (const subType of ['workflow', 'mylist', 'list', 'add', 'edit', 'detail']) {
            if (base.endsWith(`${subType}action`)) return subType;
        }
        return '';
    }

    _normalizeActionSubType(subType = '') {
        const normalized = String(subType || '').trim().toLowerCase();
        if (normalized === 'workflowaction') return 'workflow';
        if (normalized === 'workflowhtmlpage') return 'workflow';
        if (normalized === 'mylistaction') return 'mylist';
        if (normalized === 'listaction') return 'list';
        if (normalized === 'addaction') return 'add';
        if (normalized === 'editaction') return 'edit';
        if (normalized === 'detailaction') return 'detail';
        return normalized;
    }

    _normalizeGeneratedRouteBinding({ normalizedProject = '', moduleId = '', normalizedTarget = '', fileKind = '' } = {}) {
        const kind = String(fileKind || '').trim();
        if (kind !== 'Action' && kind !== 'HtmlPage') return;
        const target = String(normalizedTarget || '').trim();
        if (!target || !fs.existsSync(target)) return;
        const actionBeanName = kind === 'Action'
            ? this._actionBeanNameFromActionPath(target)
            : this._pairedActionBeanNameForHtml({
                normalizedProject,
                moduleId,
                htmlPath: target
            });
        if (!actionBeanName) return;
        try {
            const original = fs.readFileSync(target, 'utf-8');
            let next = original;
            if (kind === 'Action') {
                next = next.replace(/@RestController\s*\(\s*(['"])[^'"]*\1\s*\)/u, `@RestController("${actionBeanName}")`);
            } else {
                next = next.replace(/epoint\.initPage\s*\(\s*(['"])[^'"]*\1/u,
                    (match, quote) => `epoint.initPage(${quote}${actionBeanName}${quote}`);
            }
            if (next !== original) fs.writeFileSync(target, next, 'utf-8');
        } catch (_) {
            // route binding normalization is best-effort; unresolved templates remain visible to tests/gates.
        }
    }

    _pairedActionBeanNameForHtml({ normalizedProject = '', moduleId = '', htmlPath = '' } = {}) {
        const subType = this._htmlSubTypeFromPath(htmlPath);
        if (!subType) return '';
        try {
            const planJsonPath = this._resolvePlanJsonPath(normalizedProject);
            if (!planJsonPath || !fs.existsSync(planJsonPath)) return '';
            const planJson = JSON.parse(fs.readFileSync(planJsonPath, 'utf-8'));
            const moduleEntry = (Array.isArray(planJson.modulesOwnerFiles) ? planJson.modulesOwnerFiles : [])
                .find(m => m && String(m.moduleId || '').trim() === String(moduleId || '').trim());
            const ownerFiles = [
                ...(moduleEntry && Array.isArray(moduleEntry.ownerFiles) ? moduleEntry.ownerFiles : []),
                ...(Array.isArray(planJson.candidateFiles) ? planJson.candidateFiles : [])
            ];
            const matchedAction = ownerFiles.find(file => {
                if (String(file && file.fileKind || '').trim() !== 'Action') return false;
                const filePath = file && (file.resolvedPath || file.path || file.filePath);
                const fileSubType = this._normalizeActionSubType(file && file.subType || this._subTypeFromActionFile(filePath));
                return fileSubType === (subType === 'workflowdetail' ? 'workflow' : subType);
            });
            const actionPath = matchedAction && (matchedAction.resolvedPath || matchedAction.path || matchedAction.filePath);
            return this._actionBeanNameFromActionPath(actionPath);
        } catch (_) {
            return '';
        }
    }

    _actionBeanNameFromActionPath(actionPath = '') {
        const base = path.basename(String(actionPath || ''), '.java').trim();
        return base && /action$/iu.test(base) ? base.toLowerCase() : '';
    }

    /**
     * sectionKey 是规则模板章节选择器，属于 Builder-owned 确定事实：
     * - Entity/ServiceApi/ServiceInternal/ServiceImpl 可由 fileKind 直接确定；
     * - Action/HtmlPage 必须从 plan.json ownerFiles[].subType 派生。
     *
     * LLM-facing 工具参数不再暴露 sectionKey；旧调用显式传入时仍兼容。
     */
    _resolveSectionKeyForMaterialize({ explicitSectionKey = '', normalizedProject = '', normalizedTarget = '', fileKind = '', moduleId = '' }) {
        const explicit = String(explicitSectionKey || '').trim();

        const ownerFile = this._findOwnerFileInPlan({
            normalizedProject,
            normalizedTarget,
            fileKind,
            moduleId
        });
        if (ownerFile) {
            return this._defaultSectionKeyForFileKind(fileKind, {
                ...ownerFile, sectionKey: ownerFile.sectionKey || explicit
            });
        }

        if (explicit) return explicit;

        const kind = String(fileKind || '').trim();
        const inferredSubType = kind === 'Action'
            ? this._normalizeActionSubType(this._subTypeFromActionFile(normalizedTarget))
            : (kind === 'HtmlPage' ? this._htmlSubTypeFromPath(normalizedTarget) : '');
        // targetFile 已先通过 scan 导航合同校验。即使旧 plan 没有 owner 条目，
        // 章节仍可由稳定的 fileKind/文件名机械推出；不让 LLM 为 sectionKey 猜值。
        return this._defaultSectionKeyForFileKind(kind, {
            subType: inferredSubType
        });
    }

    _findOwnerFileInPlan({ normalizedProject = '', normalizedTarget = '', fileKind = '', moduleId = '' }) {
        try {
            const planJsonPath = this._resolvePlanJsonPath(normalizedProject);
            if (!planJsonPath || !fs.existsSync(planJsonPath)) return null;
            const planJson = this._readJson(planJsonPath);
            const modules = Array.isArray(planJson && planJson.modulesOwnerFiles) ? planJson.modulesOwnerFiles : [];
            const targetKey = this._normalizePlanTargetPath(normalizedTarget, normalizedProject);
            const expectedKind = String(fileKind || '').trim();
            const expectedModule = String(moduleId || '').trim();
            for (const moduleEntry of modules) {
                const currentModule = String(moduleEntry && moduleEntry.moduleId || '').trim();
                if (expectedModule && currentModule !== expectedModule) continue;
                const ownerFiles = Array.isArray(moduleEntry && moduleEntry.ownerFiles) ? moduleEntry.ownerFiles : [];
                for (const ownerFile of ownerFiles) {
                    const ownerKind = String(ownerFile && ownerFile.fileKind || '').trim();
                    if (expectedKind && ownerKind !== expectedKind) continue;
                    if (this._normalizePlanTargetPath(ownerFile && ownerFile.resolvedPath, normalizedProject) === targetKey) {
                        return ownerFile;
                    }
                }
            }
        } catch (_) {
            return null;
        }
        return null;
    }

    _normalizePlanTargetPath(filePath = '', normalizedProject = '') {
        const raw = String(filePath || '').trim();
        if (!raw) return '';
        const absolute = path.isAbsolute(raw) ? raw : path.resolve(normalizedProject || '.', raw);
        return path.resolve(absolute).replace(/\\/g, '/').toLowerCase();
    }

    /**
     * 全 owner 完成后构造整需求 Vibe Coding 启动卡：
     *   - 优先从 business-facts.json + design-tdd-plan.json 构造 requirementWorkPackage
     *   - requirementWorkPackage 携带完整 userStories / candidateFiles / businessFacts / rulePool
     *   - Coder 以完整需求理解 Story 连续性，candidateFiles 只作参考入口，最终在业务源码范围内完成实现
     *   - Coder 通过 demand-implementation-tasks.md 维护任务要求、当前进展和验证
     *
     * 故事线：物化完 6 件套后，LLM 不应再凭印象写测试或猜方法名，也不应按单条验收项驱动主施工。
     * Builder 拿出需求施工包，LLM 按 User Story + 参考入口 + 规则/事实完成业务代码。
     *
     * 缺 business-facts.json / 缺验收账本时返回 blocked 卡，不允许绕过 Story 事实包继续。
     */
    _buildAcceptanceChecklistCard({ normalizedProject, moduleId, args, moduleOwnerFilesCompleted }) {
        try {
            const businessFactsPath = this._resolveBusinessFactsPath(normalizedProject);
            if (!businessFactsPath || !fs.existsSync(businessFactsPath)) {
                return {
                    title: '所有模块骨架已就位，但缺少 business-facts.json',
                    status: 'blocked',
                    actionMode: 'repair_design_tdd_artifacts',
                    errorCode: 'DESIGN_TDD_BUSINESS_FACTS_MISSING',
                    stopAfter: true,
                    instruction: 'business-facts.json 是 User Story 需求施工包和验收账本的唯一事实入口。请先重跑 design_tdd_build_plan，生成后再继续业务代码补全。',
                    moduleOwnerFilesCompleted,
                    forbiddenActions: [
                        'write_business_code_without_business_facts',
                        'start_direct_vibecoding_without_acceptance_ledger'
                    ]
                };
            }
            const facts = this._readJson(businessFactsPath);
            const allModules = (facts && facts.modules) || {};
            const planJsonPath = this._resolvePlanJsonPath(normalizedProject);
            const planJson = planJsonPath && fs.existsSync(planJsonPath) ? this._readJson(planJsonPath) : null;
            const requirementWorkPackage = this._buildRequirementWorkPackage({
                facts,
                planJson,
                businessFactsPath,
                normalizedProject
            });
            if (requirementWorkPackage) {
                const requirementWorkDraft = this._buildRequirementWorkDraft(requirementWorkPackage);
                const packageRefs = this._writeRequirementWorkArtifacts({
                    normalizedProject,
                    requirementWorkDraft,
                    requirementWorkPackage,
                    modulesOwnerFiles: Array.isArray(planJson && planJson.modulesOwnerFiles) ? planJson.modulesOwnerFiles : [],
                    modulePlans: Array.isArray(planJson && planJson.modulePlans) ? planJson.modulePlans : [],
                    constructionBindings: Array.isArray(planJson && planJson.constructionBindings) ? planJson.constructionBindings : [],
                    storyWorkPackages: Array.isArray(planJson && planJson.storyWorkPackages) ? planJson.storyWorkPackages : []
                });
                const moduleCount = Array.isArray(planJson && planJson.modulesOwnerFiles) ? planJson.modulesOwnerFiles.length : Object.keys(allModules).length;
                const storyCount = requirementWorkPackage.userStories.length;
                const displayLine = `✅ 全部 ${moduleCount} 个模块骨架就位｜📦 需求施工包已就绪：${storyCount} 个 User Story`;
                const codeDir = path.dirname(businessFactsPath);
                const coderIntakeRef = packageRefs.requirementWorkDraftPath;
                const implementationTasksPath = path.join(codeDir, 'demand-implementation-tasks.md');
                return {
                    title: '所有模块骨架已就位，进入整需求 Vibe Coding',
                    status: 'skeleton_completed',
                    phase: 'vibe_coding',
                    codingMode: 'vibe_coding',
                    workUnit: 'requirement',
                    actionMode: 'direct_vibecoding',
                    awaitingUser: true,
                    stopAfter: true,
                    responseMode: 'wait_for_user_to_start_next_stage',
                    displayRequired: true,
                    displayLine: `${displayLine}；下一阶段：整需求 Vibe Coding（完整 Story 集合）`,
                    instruction: '骨架阶段到此结束。用户启动编码后，使用 epoint-design-tdd-coder 主 Skill 读取 coderIntakeRef；任务要求、当前进展和最新验证统一写入 implementationTasksPath，按主 Skill 展示当前批次 TodoList。之后不调用会推进状态的 Epoint MCP。',
                    completionSummary: {
                        moduleCount,
                        storyCount,
                        skeletonFileCount: moduleOwnerFilesCompleted.length
                    },
                    skillName: 'epoint-design-tdd-coder',
                    projectPath: String(args && args.projectPath || normalizedProject),
                    coderIntakeRef,
                    implementationTasksPath,
                    allowedNextActions: [
                        'display_skeleton_completion_then_start_direct_vibecoding'
                    ],
                    forbiddenActions: [
                        'call_coder_orchestration_mcp_after_skeleton',
                        'start_coding_before_user_starts_vibecoding',
                        'drive_work_by_single_acceptance_item_or_file_type',
                        'modify_builder_owned_truth_files',
                        'modify_platform_or_rules_directory'
                    ]
                };
            }

            return {
                title: '所有模块骨架已就位，但无法生成整需求施工资料',
                status: 'blocked',
                actionMode: 'repair_design_tdd_artifacts',
                errorCode: 'DESIGN_TDD_REQUIREMENT_WORK_PACKAGE_MISSING',
                stopAfter: true,
                instruction: 'business-facts.json 已存在，但 Builder 无法从中构建完整需求资料。请重跑 design_tdd_build_plan 重新生成 requirement-work-package 和 work-slices；不要退回到单条验收项施工。',
                reuseHint: buildReuseHint({
                    relatedFiles: Array.isArray(moduleOwnerFilesCompleted)
                        ? moduleOwnerFilesCompleted.map(item => String(item && item.resolvedPath || '').trim())
                        : []
                }),
                requiredThinking: [
                    '复用判断：先确认完整需求资料缺失是上游产物问题，不要自建 Todo 代替完整 Story 集合。',
                    '修复动作：重跑 design_tdd_build_plan 重建完整需求资料，随后由 Coder 读取全部 Story，分别写入稳定计划和动态进度。'
                ],
                forbiddenActions: [
                    'drive_work_by_single_acceptance_item_first',
                    'start_direct_vibecoding_without_requirement_work_package',
                    'fs_write_business_facts_json_directly'
                ],
                moduleOwnerFilesCompleted
            };
        } catch (_) {
            return {
                title: `所有模块骨架已就位`,
                stopAfter: false,
                instruction: '所有模块 owner 骨架文件齐了。按 Story 需求施工包继续。',
                moduleOwnerFilesCompleted
            };
        }
    }

    _buildRequirementHandoffBoundary(requirementWorkPackage = {}) {
        const candidateFiles = Array.isArray(requirementWorkPackage && requirementWorkPackage.candidateFiles)
            ? requirementWorkPackage.candidateFiles
            : [];
        const allowedFileSummary = candidateFiles
            .map(item => ({
                fileKind: String(item && item.fileKind || '').trim(),
                path: String(item && (item.resolvedPath || item.path || item.filePath) || '').trim()
            }))
            .filter(item => item.fileKind && item.path)
            .slice(0, 12);
        if (allowedFileSummary.length === 0) return null;
        return {
            purpose: '首屏文件边界：瘦身卡不内联完整施工包，但必须让 LLM 立刻看到可写范围。',
            allowedFileSummary,
            writeRule: '业务代码只能在当前需求的业务源码范围内修改或新增；allowedFileSummary / candidateFiles 是优先入口，不是最终文件清单。',
            searchRule: '需要技术事实时可用 Story、骨架类名、对象键或 API 名在工程内锚点检索；命中相近实例后停止，不用搜索结果补业务事实。',
            evidenceRule: 'Coder 把批次定义、真实改动、验收覆盖和验证结果统一记录到 demand-implementation-tasks.md；按主 Skill 展示当前 TodoList，不填写 MCP 账本或验收凭证。'
        };
    }

    _writeRequirementWorkArtifacts({
        normalizedProject = '',
        requirementWorkDraft = null,
        requirementWorkPackage = null,
        modulesOwnerFiles = [],
        modulePlans = [],
        constructionBindings = [],
        storyWorkPackages = [],
        outputCodeDir = ''
    }) {
        const businessFactsPath = this._resolveBusinessFactsPath(normalizedProject);
        const codeDir = outputCodeDir || (businessFactsPath ? path.dirname(businessFactsPath) : '');
        if (!codeDir) {
            return {
                written: false,
                reason: 'business_facts_path_unresolved'
            };
        }
        fs.mkdirSync(codeDir, { recursive: true });
        const requirementWorkDraftPath = path.join(codeDir, 'requirement-work-draft.json');
        const requirementWorkPackagePath = path.join(codeDir, 'requirement-work-package.json');
        // 首改卡与 intake 消费同一归属投影，不从候选文件另猜 Story。
        const targetIndex = this.workSliceService.buildTargetIndex({
            modulesOwnerFiles, modulePlans, constructionBindings, storyWorkPackages,
            requirementWorkPackage: requirementWorkPackage || {}
        });
        const projectedDraft = {
            ...(requirementWorkDraft || {}),
            firstEditCard: this._buildFirstEditCard({
                userStories: requirementWorkPackage && requirementWorkPackage.userStories,
                targetIndex
            })
        };
        const sliceWrite = this.workSliceService.buildAndWrite({
            codeDir,
            fullDraft: projectedDraft,
            requirementWorkPackage: requirementWorkPackage || {},
            modulesOwnerFiles: modulesOwnerFiles || [],
            modulePlans: modulePlans || [],
            constructionBindings: constructionBindings || [],
            storyWorkPackages: storyWorkPackages || [],
            targetIndex
        });
        return {
            written: true,
            requirementWorkDraftPath,
            requirementWorkPackagePath,
            workSlicesIndexPath: sliceWrite && sliceWrite.indexPath,
            resourceIndex: sliceWrite && sliceWrite.resourceIndex,
            readOrder: [
                'requirementWorkDraftPath',
                'workSlicesIndexPath'
            ],
            note: 'requirement-work-draft.json 只保留入口；先读功能目录，再从当前 Story detailRef 读取完整验收和直接资料引用。'
        };
    }

    _buildFirstEditCardSlim({ requirementWorkDraft = null, requirementWorkPackage = null, packageRefs = null } = {}) {
        try {
            const draft = requirementWorkDraft && typeof requirementWorkDraft === 'object' ? requirementWorkDraft : {};
            const pack = requirementWorkPackage && typeof requirementWorkPackage === 'object' ? requirementWorkPackage : {};
            const first = draft.firstEditCard && typeof draft.firstEditCard === 'object' ? draft.firstEditCard : {};
            const budget = draft.contextReadBudget && typeof draft.contextReadBudget === 'object' ? draft.contextReadBudget : {};
            const storyId = String(first.storyId || '').trim();
            const targetFile = String(first.targetFile || '').trim();
            const maxRefs = Math.max(1, Number(budget.maxOptionalDocRefsBeforeFirstEdit || 3) || 3);
            const mustReadRefs = uniqueNonEmptyStrings([
                packageRefs && packageRefs.requirementWorkDraftPath ? 'code/requirement-work-draft.json' : '',
                packageRefs && packageRefs.requirementWorkPackagePath ? 'code/requirement-work-package.json' : '',
                'code/business-facts.json'
            ]).slice(0, maxRefs);
            const acceptanceCodes = this._collectFirstEditAcceptanceCodes(pack, storyId);
            const relatedFiles = this._collectFirstEditRelatedFiles(pack, targetFile).slice(0, 6);
            const companyFrameworkReminder = this._buildFirstEditCompanyFrameworkReminder(first.fileKind);
            return {
                purpose: '首改瘦卡：避免先读大包拖延；读完本卡指针和目标文件后直接开始第一刀。',
                storyId,
                acceptanceCodes,
                targetFile,
                fileKind: String(first.fileKind || '').trim(),
                relatedFiles,
                mustReadRefs,
                ...(companyFrameworkReminder ? { companyFrameworkReminder } : {}),
                firstPatchInstruction: first.startInstruction
                    || '读完 mustReadRefs 和 targetFile 后，优先在 targetFile 原位补当前 Story 的第一段业务逻辑；没有 blocker 不要继续搜索工程。'
            };
        } catch (_) {
            return null;
        }
    }

    _collectFirstEditAcceptanceCodes(requirementWorkPackage = {}, storyId = '') {
        const wantedStoryId = String(storyId || '').trim().toUpperCase();
        const stories = Array.isArray(requirementWorkPackage && requirementWorkPackage.userStories)
            ? requirementWorkPackage.userStories
            : [];
        const story = stories.find(item => String(item && item.storyId || '').trim().toUpperCase() === wantedStoryId)
            || stories[0]
            || {};
        const codes = [];
        const groups = getAcceptanceGroups(story);
        Object.values(groups).forEach(items => {
            (Array.isArray(items) ? items : []).forEach(item => {
                const code = String(item && item.code || '').trim();
                if (code) codes.push(code);
            });
        });
        if (codes.length > 0) return uniqueNonEmptyStrings(codes);
        const ledgerItems = flattenBusinessFactsAcceptanceItems(requirementWorkPackage.businessFacts || {})
            .filter(entry => !wantedStoryId || String(entry && entry.storyId || '').trim().toUpperCase() === wantedStoryId)
            .map(entry => entry && entry.code);
        const ledgerCodes = uniqueNonEmptyStrings(ledgerItems);
        if (ledgerCodes.length > 0) return ledgerCodes;
        try {
            const refPath = String(requirementWorkPackage.acceptanceLedgerRef || '').split('#')[0].trim();
            if (refPath && fs.existsSync(refPath)) {
                const facts = this._readJson(refPath);
                const allLedger = flattenBusinessFactsAcceptanceItems(facts);
                const matched = uniqueNonEmptyStrings(allLedger
                    .filter(entry => !wantedStoryId || String(entry && entry.storyId || '').trim().toUpperCase() === wantedStoryId)
                    .map(entry => entry && entry.code));
                if (matched.length > 0) return matched;
                return uniqueNonEmptyStrings(allLedger.map(entry => entry && entry.code));
            }
        } catch (_) {
            return [];
        }
        return [];
    }

    _collectFirstEditRelatedFiles(requirementWorkPackage = {}, targetFile = '') {
        const target = String(targetFile || '').trim();
        const files = Array.isArray(requirementWorkPackage && requirementWorkPackage.candidateFiles)
            ? requirementWorkPackage.candidateFiles
            : [];
        return uniqueNonEmptyStrings(files
            .map(file => String(file && (file.resolvedPath || file.path) || '').trim())
            .filter(file => file && file !== target));
    }

    _buildFirstEditCompanyFrameworkReminder(fileKind = '') {
        try {
            return new TechStackGuardService().buildReminder(
                fileKind,
                '首改前公司框架写法提醒；以本项目框架为准，不要凭训练记忆套 Spring/MyBatis/Vue。'
            );
        } catch (_) {
            return null;
        }
    }

    _buildStepDraftCard({ currentAction = '', target = '', fileKind = '', focusFacts = [], nextTool = '' } = {}) {
        return {
            title: '当前步骤 Draft',
            currentAction: String(currentAction || '').trim(),
            target: String(target || '').trim(),
            mustApplyNow: uniqueNonEmptyStrings([
                '按当前 nextActionCard 单步执行，不批量、不跳步。',
                '物化阶段只调用 Builder 生成公司框架骨架，不手写业务代码。',
                '不要读取需求施工包、源码或规则 MD；等骨架全部完成并由 STOP 卡恢复后再进入首改。'
            ]).slice(0, 4),
            focusFacts: (Array.isArray(focusFacts) ? focusFacts : [])
                .map(item => String(item || '').trim())
                .filter(Boolean)
                .slice(0, 6),
            nextTool: String(nextTool || '').trim()
        };
    }

    _buildRequirementWorkPackage({ facts, planJson, businessFactsPath, normalizedProject = '' }) {
        const userStories = this._collectRequirementUserStories(facts, planJson);
        if (userStories.length === 0) return null;
        const modules = facts && facts.modules && typeof facts.modules === 'object' ? facts.modules : {};
        const historicalEntryFiles = this._collectHistoricalEntryCandidateFiles(facts, userStories, normalizedProject);
        const historicalBehaviorCards = this._collectHistoricalBehaviorCards(facts, userStories);
        const modulesOwnerFiles = Array.isArray(planJson && planJson.modulesOwnerFiles) ? planJson.modulesOwnerFiles : [];
        const candidateFiles = [];
        historicalEntryFiles.forEach(file => candidateFiles.push(file));
        for (const moduleEntry of modulesOwnerFiles) {
            const moduleId = String(moduleEntry && moduleEntry.moduleId || '').trim();
            if (!moduleId) continue;
            const moduleFacts = modules[moduleId] || {};
            const businessContext = moduleEntry.businessContext && typeof moduleEntry.businessContext === 'object'
                ? moduleEntry.businessContext
                : {};
            for (const ownerFile of (Array.isArray(moduleEntry.ownerFiles) ? moduleEntry.ownerFiles : [])) {
                const resolvedPath = String(ownerFile && ownerFile.resolvedPath || '').trim();
                const safePath = this._resolvePathInsideProject(normalizedProject, resolvedPath);
                if (!safePath) continue;
                candidateFiles.push({
                    moduleId,
                    businessObject: String(moduleFacts.businessObject || businessContext.businessObject || '').trim(),
                    fileKind: String(ownerFile.fileKind || '').trim(),
                    ...(ownerFile.subType ? { subType: String(ownerFile.subType || '').trim() } : {}),
                    ...(ownerFile.queryOnly === true ? { queryOnly: true } : {}),
                    ...(ownerFile.dataAccessPlanRef ? { dataAccessPlanRef: String(ownerFile.dataAccessPlanRef || '').trim() } : {}),
                    resolvedPath: safePath
                });
            }
        }
        const dedupedCandidateFiles = this._dedupeCandidateFiles(candidateFiles);
        const businessFacts = this._buildRequirementPackageBusinessFacts(facts, modules);
        const constructionBindings = Array.isArray(planJson && planJson.constructionBindings) ? planJson.constructionBindings : [];
        const configurationOnly = userStories.every(story => constructionBindings.some(binding =>
            binding.storyId === story.storyId && binding.bindingKind === 'configuration_only'));
        if (dedupedCandidateFiles.length === 0 && !configurationOnly) return null;
        const rulePool = this._buildRequirementPackageRulePool(facts, modules);
        const dataAccessPlans = Array.isArray(facts && facts.dataAccessPlans)
            ? facts.dataAccessPlans.filter(plan => plan && typeof plan === 'object')
            : [];
        const routeContracts = Array.isArray(facts && facts.routeContracts)
            ? facts.routeContracts
            : (Array.isArray(planJson && planJson.routeContracts) ? planJson.routeContracts : []);
        // reuseCard（指路而非缓存）：为候选 Action 指出注入的 Service 接口精确路径 + read_file 许可。
        // 只在有可指路信息时附加；blocked/null 不污染 ready 返回（守返回瘦身）。
        let reuseCard = null;
        let reuseTableGuide = null;
        try {
            const built = this.reuseCardService.buildReuseCard({
                projectPath: normalizedProject,
                candidateFiles: dedupedCandidateFiles
            });
            if (built && built.blocked !== true) reuseCard = built;
        } catch (_) {
            reuseCard = null;
        }
        try {
            const builtTableGuide = this.reuseCardService.buildReuseTableGuide({
                projectPath: normalizedProject,
                databaseTables: businessFacts.databaseTables
            });
            if (builtTableGuide && builtTableGuide.blocked !== true) reuseTableGuide = builtTableGuide;
        } catch (_) {
            reuseTableGuide = null;
        }
        return {
            driver: 'story',
            userStories,
            candidateFiles: dedupedCandidateFiles,
            businessFacts,
            rulePool,
            constructionBindings,
            ...(dataAccessPlans.length > 0 ? { dataAccessPlans } : {}),
            ...(routeContracts.length > 0 ? { routeContracts } : {}),
            ...(historicalBehaviorCards.length > 0 ? { historicalBehaviorCards } : {}),
            ...(reuseCard ? { reuseCard } : {}),
            ...(reuseTableGuide ? { reuseTableGuide } : {}),
            acceptanceLedgerRef: businessFactsPath ? `${businessFactsPath}#acceptanceLedger.items` : '',
            decisionBoundary: '系统提供完整 User Story、候选文件、业务事实和规则；candidateFiles 只作参考入口，不预设最终修改文件。请在当前业务源码范围内完成业务归因和实现。',
            evidencePolicy: {
                allowedFiles: historicalEntryFiles.length > 0
                    ? '历史功能调整优先核对 candidateFiles.resolvedPath 指向的 HtmlPage/Action 入口；实际业务源码修改必须位于 authorizedWriteRoots 内。'
                    : '业务代码修改文件必须位于 authorizedWriteRoots 内；candidateFiles.resolvedPath 只作参考入口',
                closureTool: 'demand-implementation-tasks.md',
                closureEvidence: '按连续实现批次回填实际变更文件、验收覆盖、验证命令和结果；不维护 MCP 状态或 Story 账本。',
                ...(historicalBehaviorCards.length > 0
                    ? { historicalRegression: '历史功能调整完成后，可在implementationSummary说明已核对的既有业务结果和回归范围。' }
                    : {}),
                workspaceSearch: '允许以当前 Story/骨架/API 为锚点检索项目技术实例；不以无关搜索结果补业务事实。'
            }
        };
    }

    _buildRequirementPackageBusinessFacts(facts = {}, legacyModules = {}) {
        if (facts && facts.businessFacts && typeof facts.businessFacts === 'object') {
            return JSON.parse(JSON.stringify(facts.businessFacts));
        }
        const seenTables = new Set();
        const seenObjects = new Set();
        const out = { businessObjects: [], databaseTables: [], statisticsContracts: [], workflowContracts: [] };
        Object.values(legacyModules || {}).forEach(moduleFacts => {
            const businessObject = String(moduleFacts && moduleFacts.businessObject || '').trim();
            if (businessObject && !seenObjects.has(businessObject)) {
                seenObjects.add(businessObject);
                out.businessObjects.push({ businessObject });
            }
            (Array.isArray(moduleFacts && moduleFacts.statisticsContracts) ? moduleFacts.statisticsContracts : []).forEach(contract => {
                if (contract && typeof contract === 'object' && !Array.isArray(contract)) out.statisticsContracts.push(contract);
            });
            (Array.isArray(moduleFacts && moduleFacts.workflowContracts) ? moduleFacts.workflowContracts : []).forEach(contract => {
                if (contract && typeof contract === 'object' && !Array.isArray(contract)) out.workflowContracts.push(contract);
            });
            (Array.isArray(moduleFacts && moduleFacts.databaseTables) ? moduleFacts.databaseTables : []).forEach(table => {
                const key = `${String(table && table.tableName || '').trim()}::${String(table && table.tableComment || '').trim()}`;
                if (!key.trim() || seenTables.has(key)) return;
                seenTables.add(key);
                out.databaseTables.push(table);
            });
        });
        return out;
    }

    _buildRequirementPackageRulePool(facts = {}, legacyModules = {}) {
        if (facts && facts.rulePool && typeof facts.rulePool === 'object') {
            return {
                confirmedRules: Array.isArray(facts.rulePool.confirmedRules) ? facts.rulePool.confirmedRules : [],
                selfAuditBeforeWrite: Array.isArray(facts.rulePool.selfAuditBeforeWrite) ? facts.rulePool.selfAuditBeforeWrite : [],
                apiUsageHints: Array.isArray(facts.rulePool.apiUsageHints) ? facts.rulePool.apiUsageHints : [],
                unresolvedSignals: Array.isArray(facts.rulePool.unresolvedSignals) ? facts.rulePool.unresolvedSignals : []
            };
        }
        const seenConfirmed = new Set();
        const seenAudit = new Set();
        const seenHint = new Set();
        const out = { confirmedRules: [], selfAuditBeforeWrite: [], apiUsageHints: [], unresolvedSignals: [] };
        Object.values(legacyModules || {}).forEach(moduleFacts => {
            (Array.isArray(moduleFacts && moduleFacts.confirmedRules) ? moduleFacts.confirmedRules : []).forEach(alias => {
                const ruleAlias = String(alias || '').trim();
                if (!ruleAlias || seenConfirmed.has(ruleAlias)) return;
                seenConfirmed.add(ruleAlias);
                out.confirmedRules.push(ruleAlias);
            });
            (Array.isArray(moduleFacts && moduleFacts.selfAuditBeforeWrite) ? moduleFacts.selfAuditBeforeWrite : []).forEach(item => {
                const ruleAlias = String(item && item.ruleAlias || '').trim();
                if (!ruleAlias || seenAudit.has(ruleAlias)) return;
                seenAudit.add(ruleAlias);
                out.selfAuditBeforeWrite.push(item);
            });
            (Array.isArray(moduleFacts && moduleFacts.apiUsageHints) ? moduleFacts.apiUsageHints : []).forEach(item => {
                const ruleAlias = String(item && item.ruleAlias || '').trim();
                if (!ruleAlias || seenHint.has(ruleAlias)) return;
                seenHint.add(ruleAlias);
                out.apiUsageHints.push(item);
            });
        });
        return out;
    }

    _buildRequirementWorkDraft(requirementWorkPackage = {}) {
        const userStories = Array.isArray(requirementWorkPackage.userStories) ? requirementWorkPackage.userStories : [];
        const candidateFiles = Array.isArray(requirementWorkPackage.candidateFiles) ? requirementWorkPackage.candidateFiles : [];
        const businessFacts = requirementWorkPackage.businessFacts && typeof requirementWorkPackage.businessFacts === 'object'
            ? requirementWorkPackage.businessFacts
            : {};
        const rulePool = requirementWorkPackage.rulePool && typeof requirementWorkPackage.rulePool === 'object'
            ? requirementWorkPackage.rulePool
            : {};
        const candidateFileCards = this._buildDraftCandidateFileCards(candidateFiles);
        const businessFieldCards = this._buildDraftBusinessFieldCards(businessFacts);
        const ruleCheckCards = this._buildDraftRuleCheckCards(rulePool);
        const reuseGuideCards = this._buildDraftReuseGuideCards(requirementWorkPackage.reuseCard);
        const reuseTableGuideCards = this._buildDraftReuseTableGuideCards(businessFacts, requirementWorkPackage.reuseTableGuide);
        const reuseFieldMappingCards = this._buildDraftReuseFieldMappingCards({
            dataAccessPlans: requirementWorkPackage.dataAccessPlans,
            candidateFiles,
            businessFacts
        });
        const routeCards = this._buildDraftRouteCards(requirementWorkPackage.routeContracts);
        const pageApiSelfCheckCard = this._buildPageApiSelfCheckCard({
            candidateFileCards,
            routeCards
        });
        const frontendPageSelfCheckMatrix = this._buildFrontendPageSelfCheckMatrix({
            candidateFileCards,
            routeCards,
            pageApiSelfCheckCard
        });
        const practiceCards = this.companyPracticeCardService.buildPracticeCards({
            userStories,
            candidateFiles,
            businessFacts,
            rulePool
        });
        const activeRedlineCards = this._buildDraftRedlineCards({
            userStories,
            candidateFileCards,
            businessFieldCards,
            routeCards,
            reuseGuideCards,
            reuseTableGuideCards,
            reuseFieldMappingCards,
            practiceCards,
            historicalBehaviorCards: requirementWorkPackage.historicalBehaviorCards,
            businessFacts
        });
        const contextReadBudget = this._buildContextReadBudget({
            hasReuseGuide: reuseGuideCards.length > 0,
            hasReuseTableGuide: reuseTableGuideCards.length > 0,
            hasReuseFieldMapping: reuseFieldMappingCards.length > 0,
            hasPracticeCards: practiceCards.length > 0,
            hasRouteCards: routeCards.length > 0,
            hasRedlineCards: activeRedlineCards.length > 0
        });
        const firstEditCard = this._buildFirstEditCard({
            userStories
        });
        const postEditSelfCheckCard = this._buildPostEditSelfCheckCard({
            candidateFileCards,
            routeCards,
            pageApiSelfCheckCard,
            frontendPageSelfCheckMatrix,
            activeRedlineCards,
            practiceCards,
            reuseGuideCards,
            reuseTableGuideCards,
            reuseFieldMappingCards
        });
        const historicalBehaviorCards = Array.isArray(requirementWorkPackage.historicalBehaviorCards)
            ? requirementWorkPackage.historicalBehaviorCards
            : [];
        const historicalBehaviorByStory = historicalBehaviorCards.reduce((memo, item) => {
            const storyId = String(item && item.storyId || '').trim().toUpperCase();
            if (!storyId) return memo;
            if (!memo.has(storyId)) memo.set(storyId, []);
            memo.get(storyId).push({
                businessResult: String(item && item.businessResult || '').trim(),
                regressionScope: String(item && item.regressionScope || '').trim()
            });
            return memo;
        }, new Map());
        return {
            driver: 'story_draft',
            purpose: '先理解完整 User Story 集合及其业务连续性；候选文件只作参考入口，在当前业务源码范围内补全业务逻辑。',
            storyOrder: userStories.map(story => ({
                storyId: String(story && story.storyId || '').trim(),
                userStory: String(story && story.userStory || '').trim()
            })).filter(item => item.storyId && item.userStory),
            storyCards: userStories.map((story, index) => {
                const storyId = String(story && story.storyId || '').trim();
                const preserveCards = historicalBehaviorByStory.get(storyId.toUpperCase()) || [];
                const acceptanceItems = this._buildDraftStoryAcceptanceItems(story);
                const storyMappingCards = this._reuseFieldMappingCardsForStory(reuseFieldMappingCards, story, acceptanceItems);
                const workSteps = [
                    '执行、取证和恢复统一按 epoint-design-tdd-coder 主 Skill；本卡只提供当前 Story 的要求与资料引用，不另设开工步骤。'
                ];
                return {
                    storyId,
                    userStory: String(story && story.userStory || '').trim(),
                    invariants: Array.isArray(story && story.invariants) ? story.invariants : [],
                    ...(acceptanceItems.length > 0 ? { acceptanceItems } : {}),
                    ...(preserveCards.length > 0 ? { historicalBehaviorCards: preserveCards } : {}),
                    workSteps,
                    ...(activeRedlineCards.length > 0 ? { redlineGuideRef: 'work-slices/rules/Common.json#redlineGuide.activeCards' } : {}),
                    candidateFileGuideRef: 'work-slices/files-fields.json#candidateFileCards',
                    businessFactsRef: 'work-slices/files-fields.json#businessFieldCards',
                    ruleGuideRef: 'readCatalog.byFileKind[当前fileKind] -> work-slices/rules/<fileKind>.json#ruleMenuCards -> contentRef',
                    ...(reuseGuideCards.length > 0 ? {
                        reuseGuideRef: 'requirementWorkDraft.reuseGuideCards',
                        reuseGuideSourceRef: 'work-slices/reuse.json#reuseGuideCards'
                    } : {}),
                    ...(reuseTableGuideCards.length > 0 ? {
                        reuseTableGuideRef: 'requirementWorkDraft.reuseTableGuideCards',
                        reuseTableGuideSourceRef: 'work-slices/reuse.json#reuseTableGuideCards'
                    } : {}),
                    ...(storyMappingCards.length > 0 ? {
                        reuseFieldMappingRef: 'requirementWorkDraft.reuseFieldMappingCards',
                        reuseFieldMappingSourceRef: 'work-slices/reuse.json#reuseFieldMappingCards'
                    } : {}),
                    ...(practiceCards.length > 0 ? { practiceGuideRef: 'readCatalog.byFileKind[当前fileKind] -> work-slices/practices/<fileKind>.json#practiceCards' } : {}),
                    sequence: index + 1
                };
            }).filter(card => card.storyId && card.userStory),
            contextReadBudget,
            firstEditCard,
            postEditSelfCheckCard,
            redlineGuide: {
                globalPrinciplesRef: 'references/coder-redlines.md',
                usage: '先看 activeCards；只在卡片不够具体时按 docRefs 精确读取，不要全文背诵红线总纲。',
                activeCards: activeRedlineCards
            },
            candidateFileCards,
            businessFieldCards,
            ruleCheckCards,
            ...(routeCards.length > 0 ? { routeCards } : {}),
            ...(pageApiSelfCheckCard ? { pageApiSelfCheckCard } : {}),
            ...(frontendPageSelfCheckMatrix ? { frontendPageSelfCheckMatrix } : {}),
            ...(reuseGuideCards.length > 0 ? { reuseGuideCards } : {}),
            ...(reuseTableGuideCards.length > 0 ? { reuseTableGuideCards } : {}),
            ...(reuseFieldMappingCards.length > 0 ? { reuseFieldMappingCards } : {}),
            ...(practiceCards.length > 0 ? { practiceCards } : {}),
            afterWrite: {
                closureTool: 'demand-implementation-tasks.md',
                selfCheckRef: 'work-slices/self-check.json#postEditSelfCheckCard',
                evidence: '每个连续实现批次完成后，记录真实变更文件、AC 覆盖、聚焦验证和已知限制。'
            },
            doNot: [
                '不要只按 storyCards 顺序逐条交付；先识别连续 Story 并建立实施计划。',
                '不要用“再确认一下”代替理解和计划；没有新问题不要重复读取同一资料。',
                '需要技术事实时可以用当前 Story、骨架或 API 名在工程内锚点检索，不能用无关结果补业务事实。',
                '业务源码只能在当前需求业务范围内修改或新增；TARGET|write和候选文件仅作参考入口。',
                '不要把 redlineGuide 当成新 Gate；它只负责写前导向，具体实现仍以业务事实、候选文件、practiceCards、routeCards 和复用卡为准。',
                '不要凭印象重造 reuseGuideCards 已指出的既有方法、工具类调用、返回字段或关联实体。',
                '不要忽略 routeCards：裸 epoint.execute 只能走 initPage 默认 Action，跨 Action 必须显式 action/method。',
                '不要自由遍历 company-practices 目录；按当前行为命中章节，卡片漏列时按主 Skill定向补读。',
                '不要跳过 postEditSelfCheckCard 和真实验证直接声称需求完成。',
                '不要调用编码编排工具伪造计划、验收或完成状态。'
            ]
        };
    }

    _buildContextReadBudget({
        hasReuseGuide = false,
        hasReuseTableGuide = false,
        hasReuseFieldMapping = false,
        hasPracticeCards = false,
        hasRouteCards = false,
        hasRedlineCards = false
    } = {}) {
        const optionalRefs = [];
        if (hasRedlineCards) optionalRefs.push('work-slices/rules/Common.json#redlineGuide.activeCards');
        if (hasReuseGuide) optionalRefs.push('work-slices/reuse.json#reuseGuideCards');
        if (hasReuseTableGuide) optionalRefs.push('work-slices/reuse.json#reuseTableGuideCards');
        if (hasReuseFieldMapping) optionalRefs.push('work-slices/reuse.json#reuseFieldMappingCards');
        if (hasPracticeCards) optionalRefs.push('readCatalog.byFileKind[当前fileKind] -> work-slices/practices/<fileKind>.json#practiceCards.mustReadReferences');
        if (hasRouteCards) optionalRefs.push('work-slices/routes.json#routeCards');
        return {
            purpose: '启动只读小入口和全部功能目录；当前任务从 detailRef 读取完整 Story/AC 和必要资料，不预读完整工作包。',
            requiredReads: [
                'code/requirement-work-draft.json',
                'work-slices/stories.json#stories'
            ],
            optionalReadsBeforeFirstEdit: optionalRefs,
            optionalReadRule: '首改前取 1-3 类资料是减少无关读取的建议，不是硬上限；当前任务必要的规则正文和源码不能因数量限制省略，适用条件与补读按主 Skill，不要全文遍历 references。',
            maxOptionalDocRefsBeforeFirstEdit: 3,
            perFileLimit: '避免无目的重复读取；发现具体新问题时可以回读相关文件并说明原因。',
            technicalEvidenceOrder: '技术查证和证据复用按主 Skill“技术不确定性查证顺序”执行。',
            unavailableEvidenceToolRule: 'CodeGraph或Nextbot未安装、未注册、不可用、超时或无结果时记录原因并继续，不等待、不退回设计、不标记blocked。',
            firstPatchThreshold: '按主 Skill确认当前任务必要事实后，立即写对应行为测试或业务实现；测试先行后立即实现对应行为。',
            startRule: '只读 intake 与 storyCatalogRef 后先写计划和进度；当前任务从 detailRef 直接读取完整验收、骨架、事实和适用规则。readCatalogRef 仅用于补充导航，design-tdd-plan.json 仅在导航或承载信息不足时定向读取；执行与开工统一按主 Skill。'
        };
    }

    _buildFirstEditCard({
        userStories = [],
        targetIndex = []
    } = {}) {
        const stories = (Array.isArray(userStories) ? userStories : [])
            .filter(item => String(item && item.storyId || '').trim() && String(item && item.userStory || '').trim());
        const targets = Array.isArray(targetIndex) ? targetIndex : [];
        const writableFor = storyId => targets.filter(target => {
            const belongs = (Array.isArray(target.storyIds) ? target.storyIds : []).includes(storyId)
                || (Array.isArray(target.storyBindings) ? target.storyBindings : []).some(binding => binding.storyId === storyId);
            return belongs && target.accessByStoryId && target.accessByStoryId[storyId] === 'write';
        });
        const story = stories.find(item => writableFor(String(item.storyId).trim()).length > 0) || stories[0] || {};
        const storyId = String(story && story.storyId || '').trim();
        const preferredKinds = ['Action', 'ServiceInternal', 'HtmlPage', 'ServiceApi', 'ServiceImpl', 'Entity'];
        const cards = writableFor(storyId);
        // 根据 story 的 constructionSceneKey 推断首选 subType，避免把查询 Story 入口指向 add/workflow
        const storyBindings = cards.flatMap(card => Array.isArray(card.storyBindings) ? card.storyBindings : [])
            .filter(binding => String(binding && binding.storyId || '').trim().toUpperCase() === storyId.toUpperCase());
        const sceneKey = storyBindings.length > 0
            ? String(storyBindings[0] && storyBindings[0].constructionSceneKey || '').trim()
            : '';
        const preferredSubTypes = sceneKey === 'query_result_entry'
            ? ['list', 'mylist']
            : sceneKey === 'workflow_process'
                ? ['add', 'workflow']
                : [];
        const cardsForKind = kind => preferredSubTypes.length > 0
            ? cards.filter(file => String(file && file.fileKind || '').trim() === kind
                && preferredSubTypes.includes(String(file && file.subType || '').trim()))
            : cards.filter(file => String(file && file.fileKind || '').trim() === kind);
        const target = preferredKinds
            .map(kind => cardsForKind(kind)[0])
            .find(Boolean)
            || preferredKinds
                .map(kind => cards.find(file => String(file && file.fileKind || '').trim() === kind))
                .find(Boolean)
            || cards[0]
            || {};
        const fileKind = String(target && target.fileKind || '').trim();
        const targetFile = String(target && target.resolvedPath || '').trim();
        const focusByKind = {
            Action: '补页面动作、查询、按钮响应、参数接收或 Service 调用；已有 Service 方法时优先复用。',
            ServiceInternal: '补查询、保存、删除、校验、状态流转或事务性业务处理。',
            HtmlPage: '补按钮、结果区、表单字段、datagrid 列或 epoint.execute 调用，并与 routeCards 闭合。',
            ServiceApi: '只声明本需求需要的服务方法，不重复造已有接口。',
            ServiceImpl: '只做接口实现转发，不写复杂业务。',
            Entity: '只补数据库业务字段访问方法。',
            Rest: '补当前 Story 的 REST 业务入口并闭合 Service 调用。',
            Job: '补当前 Story 的调度业务并验证注册和处理结果。'
        };
        return {
            purpose: '给 Coder 一个高信号首个入口，帮助它从完整需求中选择第一个连续实现批次。',
            storyId,
            userStory: String(story && story.userStory || '').trim(),
            targetFile,
            fileKind,
            action: focusByKind[fileKind] || '暂无可写首改推荐；按有效 targetIndex 和主 Skill在授权范围内组织实施，不借用其它 Story 的文件。',
            beforeEditChecklist: [
                '已按当前业务批次的 readCatalog 读取 Story、目标源码和必要规则/复用资料；不要求预读完整工作包。',
                targetFile ? '已读 targetFile 当前内容及必要调用方。' : '',
                '规则菜单及实践卡按当前行为选择；适用条件成立后读取必要正文，资料漏列时按主 Skill 定向补读。'
            ].filter(Boolean),
            technicalEvidenceOrder: [
                '按主 Skill“技术不确定性查证顺序”取证，已有有效结论直接复用。'
            ],
            unavailableEvidenceToolRule: 'CodeGraph或Nextbot未安装、未注册、不可用、超时或无结果时，记录原因并继续本地实现；不要求安装、不退回设计、不把批次标记为blocked。',
            firstPatchRule: '按主 Skill 确认必要事实后，下一动作必须写对应行为测试或业务实现；测试先行后立即实现对应行为。',
            startInstruction: '首改只是当前 Story 的可写入口提示，不代替批次规划；执行流程统一按主 Skill，不因缺项目样例继续无目的查证。',
            existingEntryOrder: ''
        };
    }

    _buildPostEditSelfCheckCard({
        candidateFileCards = [],
        routeCards = [],
        pageApiSelfCheckCard = null,
        frontendPageSelfCheckMatrix = null,
        activeRedlineCards = [],
        practiceCards = [],
        reuseGuideCards = [],
        reuseTableGuideCards = [],
        reuseFieldMappingCards = []
    } = {}) {
        const fileKinds = new Set((Array.isArray(candidateFileCards) ? candidateFileCards : [])
            .map(file => String(file && file.fileKind || '').trim())
            .filter(Boolean));
        const hasHtml = fileKinds.has('HtmlPage');
        const hasJava = ['Action', 'ServiceApi', 'ServiceInternal', 'ServiceImpl', 'Entity']
            .some(kind => fileKinds.has(kind));
        const hasAction = fileKinds.has('Action');
        const hasRouteCards = Array.isArray(routeCards) && routeCards.length > 0;
        const hasPracticeCards = Array.isArray(practiceCards) && practiceCards.length > 0;
        const hasRedlineCards = Array.isArray(activeRedlineCards) && activeRedlineCards.length > 0;
        const hasCallClosureCard = (Array.isArray(activeRedlineCards) ? activeRedlineCards : [])
            .some(card => String(card && card.id || '').trim() === 'CALL_CLOSURE');
        const shouldSelfCheckCallClosure = hasRouteCards || ((hasHtml || hasAction) && hasCallClosureCard);
        const hasReuseCards = [reuseGuideCards, reuseTableGuideCards, reuseFieldMappingCards]
            .some(list => Array.isArray(list) && list.length > 0);
        return {
            purpose: '每个连续实现批次完成后的轻量自查；不是新 Gate，不要求长篇报告。',
            timing: '批次涉及的验收项对应业务逻辑补完后执行一次。',
            checklist: [
                '改动文件仍在 authorizedWriteRoots 内；candidateFileCards、requirementWorkPackage.candidateFiles 和既有入口仅作参考。',
                '既有文件 diff 已自查：除当前需求明确要求的最小业务 delta 外，旧接口、旧方法签名、旧函数名、旧选择器、旧配置 key、旧路由、旧资源路径、旧样式语义、旧显示隐藏状态没有被误改。',
                hasRedlineCards ? '本次 active redline cards 未被违反；若有冲突，先修代码，不用 evidence 掩盖。' : '',
                hasPracticeCards ? '命中的 practiceCards/docRefs 已按需读取并落实到必要源码；没有命中的实践不额外展开。' : '',
                hasHtml ? '前端仍是 MiniUI/FUI/epoint.*，未引入 fetch/axios/$.ajax/原生弹窗或其它前端框架。' : '',
                hasHtml ? '页面增量修改只新增或局部调整本需求 DOM；旧/原有/既有按钮、表单、表格、弹窗的 hidden、class、id、onclick、bind、action 等属性未被误改。' : '',
                pageApiSelfCheckCard ? '如果本次改了 HtmlPage，已按 pageApiSelfCheckCard 逐项核对页面 API 调用、事件绑定、Action public 方法、参数和返回结构。' : '',
                shouldSelfCheckCallClosure ? '页面调用已按 routeCards 或 CALL_CLOSURE 闭合：initPage/action/execute/export/combobox 均能回到 Action public 方法。' : '',
                hasRouteCards ? '新增或修改 epoint.execute 已按 executeParamContract：跨 Action 显式 action/method，第三参不传对象，多参数传数组。' : '',
                hasReuseCards ? '复用入口、复用表或复用字段按 reuse*Cards 落地，没有凭空编字段、方法或工具类。' : '',
                hasJava ? '后端仍是 Epoint Action/Service/Entity/CommonDao 风格，未引入通用 Spring Boot/JPA/MyBatis/Lombok 写法。' : '',
                '本次代码能对应到当前 acceptanceItems[].given/when/then 的可验收结果。'
            ].filter(Boolean),
            ...(pageApiSelfCheckCard ? { pageApiSelfCheckCard } : {}),
            ...(frontendPageSelfCheckMatrix ? { frontendPageSelfCheckMatrix } : {}),
            evidenceGuidance: '把真实变更文件、验收覆盖、验证命令和结果写入 demand-implementation-tasks.md；不要填写 stepId、ledger 或 MCP evidence。',
            antiPattern: [
                '不要编造“已阅读全部 MD”的证据。',
                '不要用自审替代真实测试/编译；能直接验证的结果必须运行命令并记录输出。',
                '不要为了自审扩大修改范围或顺手重构。'
            ]
        };
    }

    _buildFrontendPageSelfCheckMatrix({
        candidateFileCards = [],
        routeCards = [],
        pageApiSelfCheckCard = null
    } = {}) {
        const htmlFiles = (Array.isArray(candidateFileCards) ? candidateFileCards : [])
            .filter(file => String(file && file.fileKind || '').trim() === 'HtmlPage')
            .map(file => String(file && file.path || '').trim())
            .filter(Boolean)
            .slice(0, 8);
        if (htmlFiles.length === 0) return null;
        const hasRouteCards = Array.isArray(routeCards) && routeCards.length > 0;
        return {
            purpose: 'HtmlPage 修改前后的固定自检矩阵；只约束前端页面，不检查后台 Service/Entity/Job。',
            timing: '修改后检查受影响的页面调用；一个可验证业务结果完成后汇总检查。',
            scope: {
                appliesTo: ['HtmlPage'],
                notAppliesTo: ['Action', 'ServiceApi', 'ServiceInternal', 'ServiceImpl', 'Entity', 'Job', 'Rest']
            },
            htmlFiles,
            routeCardsRef: hasRouteCards ? 'work-slices/routes.json#routeCards' : '',
            pageApiSelfCheckRef: pageApiSelfCheckCard ? 'work-slices/routes.json#pageApiSelfCheckCard' : '',
            matrix: [
                {
                    item: 'initPage 默认 Action',
                    okWhen: "页面 epoint.initPage('xxxaction') 与裸 epoint.execute('method') 的默认路由一致。",
                    failFix: '目标方法不在默认 Action 时，改成 epoint.execute("otheraction/method", ...)。'
                },
                {
                    item: '页面 action / execute 闭合',
                    okWhen: 'mini-datagrid/combobox/dataexport action 和 epoint.execute 都能闭合到候选或既有 Action public 方法。',
                    failFix: '缺 public 方法就补候选 Action；跨 Action 就显式 action/method；证据不足只保留 warning。'
                },
                {
                    item: '页面 bind 属性闭合',
                    okWhen: '裸 bind="xxx" 在当前 initPage Action 有 getXxx/setXxx；bind="dataBean.xxx" 在 dataBean 实体有对应 getter/setter。',
                    failFix: '查询/隐藏字段补 Action JavaBean 属性；表单字段改回 dataBean.xxx 并补实体字段，不能只改 HTML。'
                },
                {
                    item: '参数与返回',
                    okWhen: '前端参数个数、顺序、数组写法与 Java public 方法签名一致，回调读取字段与 addCallbackParam/返回结构一致。',
                    failFix: '按 routeCards/pageApiSelfCheckCard 修参数和返回字段，不传对象当第三参。'
                },
                {
                    item: '公司前端框架',
                    okWhen: '页面仍使用 FUI/MiniUI/epoint.*，不新增 fetch/axios/$.ajax/Vue/React/原生 alert，且保留 cssboot/jsboot/page-loading 等启动资源。',
                    failFix: '按前端 API 卡改回 epoint.execute/refresh/alert/confirm/openDialog；若缺 rest/resource/jsboot，只在第一个业务 inline script 前补回 jsboot 标签。'
                },
                {
                    item: '业务展示文案',
                    okWhen: '标题、查询 label、表格列头、emptyText 使用用户可理解的业务中文；有中文业务含义时不直接上屏 raw 字段名或实体类注释。',
                    failFix: '把 api_url/input_params/实体类列表这类机读词改成业务中文；接口字段确需原样展示时在 evidence.summary 说明原因。'
                },
                {
                    item: '既有页面保护',
                    okWhen: '既有页面只做本需求增量修改，未误改旧按钮、表单、表格、弹窗的 id/class/hidden/onClick/bind/action。',
                    failFix: '回退非本需求 DOM 改动，只保留当前 Story 需要的增量。'
                }
            ]
        };
    }

    _buildPageApiSelfCheckCard({ candidateFileCards = [], routeCards = [] } = {}) {
        const htmlFiles = (Array.isArray(candidateFileCards) ? candidateFileCards : [])
            .filter(file => String(file && file.fileKind || '').trim() === 'HtmlPage')
            .map(file => String(file && file.path || '').trim())
            .filter(Boolean)
            .slice(0, 8);
        const actionFiles = (Array.isArray(candidateFileCards) ? candidateFileCards : [])
            .filter(file => String(file && file.fileKind || '').trim() === 'Action')
            .map(file => String(file && file.path || '').trim())
            .filter(Boolean)
            .slice(0, 8);
        const hasRouteCards = Array.isArray(routeCards) && routeCards.length > 0;
        if (htmlFiles.length === 0 && !hasRouteCards) return null;
        const pageRouteContracts = (Array.isArray(routeCards) ? routeCards : [])
            .map(card => card && card.pageRouteContract)
            .filter(Boolean)
            .slice(0, 4);
        return {
            purpose: '页面改完后立即做 LLM 自检：确认前端调用和后台 Action 方法闭合；这是自检卡，不是新 Gate，但闭合不成立时不得 mark。',
            timing: '修改后只检查受影响的绑定、调用和参数；一个可验证业务结果完成后执行完整检查。',
            trigger: [
                '新增或修改按钮/链接/表格行操作/弹窗回调',
                '新增或修改 epoint.execute、控件 action、导出、下拉数据源、页面初始化调用',
                '新增或修改 HtmlPage bind 查询条件、隐藏字段或表单字段',
                '修改前端回调里读取返回值或刷新列表的逻辑'
            ],
            htmlFiles,
            actionFiles,
            routeCardsRef: hasRouteCards ? 'work-slices/routes.json#routeCards' : '',
            ...(pageRouteContracts.length > 0 ? { pageRouteContracts } : {}),
            checklist: [
                '事件绑定：新增按钮或控件事件已真实绑定到页面方法，不只是写了孤立函数。',
                '默认 Action：裸 epoint.execute("method") 只调用 epoint.initPage 默认 Action 的 public method。',
                '跨 Action：方法写在其它 Action 时，前端使用 action/method 显式调用。',
                '后台方法：每个新增/修改的页面调用都能在候选 Action 中找到同名 public 方法。',
                'bind 闭合：裸 bind="xxx" 在当前 initPage Action 中有 getXxx/setXxx；bind="dataBean.xxx" 在 getDataBean() 返回实体中有对应 getter/setter。',
                '参数口径：前端传参顺序/数组/字符串与 Java public 方法形参读取方式一致；第三参不传对象。',
                '返回结构：Action 返回 JSON 字段与前端回调读取字段一致，列表刷新/弹窗关闭/错误提示有对应处理。',
                '公司框架：页面调用仍使用 epoint/MiniUI/FUI 项目写法，未绕成 fetch/axios/$.ajax/Vue/React。'
            ],
            evidenceSummaryHint: 'summary 写清“页面哪个调用/bind ↔ 哪个 Action.public 方法或 JavaBean 属性 ↔ 参数/返回如何闭合”，不要只写“页面已修改”。'
        };
    }

    _buildCompactPageRouteContract(contract = {}) {
        const htmlPage = String(contract && contract.htmlPage || '').trim();
        const defaultActionName = String(contract && contract.defaultActionName || '').trim();
        const candidateActions = (Array.isArray(contract && contract.candidateActions) ? contract.candidateActions : [])
            .map(action => {
                const actionName = String(action && action.actionName || '').trim();
                const methods = uniqueNonEmptyStrings(Array.isArray(action && action.methods) ? action.methods : []).slice(0, 16);
                if (!actionName && methods.length === 0) return null;
                return {
                    actionName,
                    path: String(action && (action.path || action.resolvedPath || action.filePath) || '').trim(),
                    methods,
                    routeRule: actionName && actionName === defaultActionName
                        ? "该 Action 是 initPage 默认 Action，允许 epoint.execute('method') 裸方法。"
                        : `该 Action 不是 initPage 默认 Action，调用其方法必须写 epoint.execute('${actionName}/method')。`
                };
            })
            .filter(Boolean)
            .slice(0, 6);
        const forbiddenBareExecuteMethods = uniqueNonEmptyStrings(candidateActions
            .filter(action => action.actionName && action.actionName !== defaultActionName)
            .flatMap(action => Array.isArray(action.methods) ? action.methods : []))
            .slice(0, 24);
        const allowedExecuteForms = uniqueNonEmptyStrings(candidateActions
            .map(action => {
                const actionName = String(action && action.actionName || '').trim();
                if (!actionName) return '';
                return actionName === defaultActionName
                    ? `epoint.execute('method') // method 必须在 ${actionName}`
                    : `epoint.execute('${actionName}/method')`;
            }))
            .slice(0, 8);
        if (!htmlPage && !defaultActionName && candidateActions.length === 0) return null;
        return {
            htmlPage,
            defaultActionName,
            decisionRule: defaultActionName
                ? `裸 epoint.execute('method') 只路由到 ${defaultActionName}；method 在其它候选 Action 时必须显式 action/method。`
                : '未识别 initPage 默认 Action，不要新增裸 epoint.execute。',
            candidateActions,
            allowedExecuteForms,
            forbiddenBareExecuteMethods,
            existingFrontendCalls: (Array.isArray(contract && contract.frontendCalls) ? contract.frontendCalls : [])
                .map(call => ({
                    type: String(call && call.type || '').trim(),
                    raw: String(call && call.raw || '').trim()
                }))
                .filter(call => call.type && call.raw)
                .slice(0, 12),
            selfCheck: '新增/修改页面调用前，先用 forbiddenBareExecuteMethods 判断是否不能裸写；若命中，改成 allowedExecuteForms 中的显式 action/method。'
        };
    }

    _buildDraftRedlineCards({
        userStories = [],
        candidateFileCards = [],
        businessFieldCards = {},
        routeCards = [],
        reuseGuideCards = [],
        reuseTableGuideCards = [],
        reuseFieldMappingCards = [],
        practiceCards = [],
        historicalBehaviorCards = [],
        businessFacts = {}
    } = {}) {
        const cards = [];
        const fileKinds = new Set((Array.isArray(candidateFileCards) ? candidateFileCards : [])
            .map(file => String(file && file.fileKind || '').trim())
            .filter(Boolean));
        const hasHtml = fileKinds.has('HtmlPage');
        const hasJava = ['Action', 'ServiceApi', 'ServiceInternal', 'ServiceImpl', 'Entity']
            .some(kind => fileKinds.has(kind));
        const hasAction = fileKinds.has('Action');
        const hasRoute = Array.isArray(routeCards) && routeCards.length > 0;
        const hasReuse = [reuseGuideCards, reuseTableGuideCards, reuseFieldMappingCards]
            .some(list => Array.isArray(list) && list.length > 0);
        const hasHistorical = Array.isArray(historicalBehaviorCards) && historicalBehaviorCards.length > 0;
        const practiceIds = new Set((Array.isArray(practiceCards) ? practiceCards : [])
            .map(card => String(card && card.practiceId || '').trim())
            .filter(Boolean));
        const ruleTexts = [
            ...(Array.isArray(businessFacts && businessFacts.confirmedRules) ? businessFacts.confirmedRules : []),
            ...(Array.isArray(businessFacts && businessFacts.ruleRefs) ? businessFacts.ruleRefs : [])
        ].map(item => String(item || '').trim()).filter(Boolean);
        const candidatePaths = (Array.isArray(candidateFileCards) ? candidateFileCards : [])
            .map(file => String(file && file.path || '').replace(/\\/g, '/').toLowerCase());
        const hasDataRisk = practiceIds.has('GP-10')
            || practiceIds.has('GP-11')
            || ruleTexts.some(text => /事务|幂等|补偿|MQ|Job|定时/.test(text))
            || candidatePaths.some(filePath => /\/job\/|job\.java$|listener\.java$|consumer\.java$|mq/.test(filePath));
        const hasSensitiveSignal = practiceIds.has('GP-12')
            || ruleTexts.some(text => /凭证|密钥|安全|SSO|白名单|License|前置库|配置/.test(text))
            || candidatePaths.some(filePath => /jdbc|license|security|sso|white|config|properties|\.xml$/.test(filePath));
        const tables = Array.isArray(businessFieldCards && businessFieldCards.tables)
            ? businessFieldCards.tables
            : [];
        const hasBusinessFields = tables.some(table => Array.isArray(table && table.fields) && table.fields.length > 0);

        const add = card => {
            if (!card || !card.id || cards.some(item => item.id === card.id)) return;
            cards.push(card);
        };

        if (hasHtml || hasJava) {
            add({
                id: 'PROJECT_STACK_BOUNDARY',
                title: '不得脱离项目现有技术栈',
                why: '本次候选文件涉及前端或后端公司框架代码。',
                mustDo: [
                    hasJava ? '后端沿用 Epoint Action/Service/Entity/CommonDao 风格，不引入通用 Spring Boot/JPA/MyBatis/Lombok 写法。' : '',
                    hasHtml ? '前端沿用 MiniUI/FUI/epoint.*，不引入现代前端框架、原生接口调用或原生表单提交。' : ''
                ].filter(Boolean),
                docRefs: [
                    ...(hasJava ? ['references/backend-rules-checklist.md'] : []),
                    ...(hasHtml ? ['references/frontend-rules.md'] : []),
                    'references/coder-redlines.md'
                ]
            });
        }

        if (hasHtml || hasAction || hasRoute) {
            add({
                id: 'CALL_CLOSURE',
                title: '前后端调用必须真实闭合',
                why: '本次候选文件或 routeCards 涉及页面初始化、控件 action 或按钮调用。',
                mustDo: [
                    '先看 routeCards；API 细节只读 epoint-api-contract，不重复翻前端清单。',
                    '页面 action、execute、下拉数据源、导出动作必须能回到候选 Action 或已确认复用 Action 的 public 方法。',
                    '缺方法时补齐候选 Action 方法或停下说明缺口，不写“后台后续补”。'
                ],
                docRefs: [
                    'references/frontend-rules.md#页面动作闭合与历史入口保护',
                    'references/company-practices/frontend/epoint-api-contract.md',
                    'references/coder-redlines.md'
                ]
            });
        }

        if (hasReuse || hasBusinessFields) {
            add({
                id: 'PROJECT_ASSET_EVIDENCE',
                title: '不得凭空编造项目资产和业务字段',
                why: '本次施工涉及业务字段、复用实体、复用方法或公司实践卡。',
                mustDo: [
                    '字段、列头、查询条件、导出字段必须来自 businessFieldCards、reuseFieldMappingCards、候选文件 bind 或同类样例。',
                    'Service/API/工具类/配置 key 只能来自复用卡、规则文档、候选文件或项目样例；缺证据就停下确认。'
                ],
                docRefs: [
                    'references/coder-redlines.md',
                    ...(hasReuse ? ['references/skeleton-reuse.md'] : [])
                ]
            });
        }

        if (hasHistorical || reuseGuideCards.length > 0) {
            add({
                id: 'EXISTING_ENTRY_SCOPE',
                title: '不得扩大既有功能改造范围',
                why: '本次施工涉及历史入口、复用入口或既有行为保护。',
                mustDo: [
                    '只围绕本 Story 的可验收结果，在 authorizedWriteRoots 内增量修改或新增业务源码。',
                    '保留原页面查询、保存、分页、按钮、URL 参数和历史业务行为；不做无关重构或格式化。'
                ],
                docRefs: [
                    'references/code-generation.md',
                    'references/coder-redlines.md'
                ]
            });
        }

        if (practiceIds.has('GP-08')) {
            add({
                id: 'ATTACHMENT_LIFECYCLE',
                title: '不得破坏附件 GUID 生命周期',
                why: '公司实践卡命中附件上传、预览或下载能力。',
                mustDo: [
                    '新增页首次进入生成稳定附件标识，postback 恢复，编辑页复用库中标识。',
                    '按项目当前上传组件和附件模型实现，不自造上传接口，不引用已删除组件。'
                ],
                docRefs: [
                    'references/company-practices/integration/attachment-index.md',
                    'references/coder-redlines.md'
                ]
            });
        }

        if (practiceIds.has('GP-09')) {
            add({
                id: 'EXPORT_CLOSURE',
                title: '导出必须形成页面与后台闭合',
                why: '公司实践卡命中导入导出能力。',
                mustDo: [
                    '前端导出按钮绑定 datagrid、查询条件和 getExportModel。',
                    '后端 ExportModel 字段名与中文列名数量一致，字段来自业务事实或复用字段映射。'
                ],
                docRefs: [
                    'references/company-practices/integration/import-export.md',
                    'references/feature-bridges.md#2-导入--导出import_export'
                ]
            });
        }

        if (hasDataRisk) {
            add({
                id: 'DATA_CONSISTENCY',
                title: '不得破坏数据和事务一致性',
                why: 'Story 文本出现批量、状态、同步、外部调用、Job/MQ 或事务补偿类信号。',
                mustDo: [
                    '涉及多表、主从、批量、状态流转、同步或外部调用副作用时，必须有事务、幂等、失败处理或明确补偿策略。',
                    '不能吞异常后继续返回成功；失败必须有可验收业务后果。'
                ],
                docRefs: [
                    'references/backend-rules-checklist.md',
                    'references/coder-redlines.md'
                ]
            });
        }

        if (hasSensitiveSignal) {
            add({
                id: 'CONFIG_SECURITY',
                title: '不得泄露或硬编码敏感配置',
                why: 'Story 文本出现凭证、连接、白名单、SSO 或高风险配置类信号。',
                mustDo: [
                    '账号、密码、token、secret、证书、License、连接串不得进入代码、日志、测试数据或最终回复。',
                    '高风险配置默认只读；确需修改时必须有用户明确参数和项目样例。'
                ],
                docRefs: [
                    'references/coder-redlines.md'
                ]
            });
        }

        add({
            id: 'ACCEPTANCE_CLOSURE',
            title: '不得绕过验收闭环',
            why: '所有 Story 施工都必须回到验收项和证据。',
            mustDo: [
                '每个连续实现批次完成后，回到原始 Story 和验收项核对真实业务结果。',
                '把实际变更文件、验收覆盖、验证命令和结果写入 demand-implementation-tasks.md。'
            ],
            docRefs: [
                'references/code-generation.md',
                'references/coder-redlines.md'
            ]
        });

        return cards.slice(0, 6);
    }

    _buildDraftCandidateFileCards(candidateFiles = []) {
        const useWhenByKind = {
            Entity: '需要补业务字段访问方法时使用。',
            ServiceApi: '需要声明页面或业务动作调用的服务方法时使用。',
            ServiceInternal: '需要查询、保存、删除、校验、状态或版本等业务处理时使用。',
            ServiceImpl: '需要把服务接口方法转发到内部业务处理时使用。',
            Action: '需要响应页面查询、保存、删除、导出或按钮动作时使用；历史功能调整时只在该入口内补请求响应、校验或服务调用。',
            HtmlPage: '需要补列表、表单、按钮、弹窗或前端交互时使用；历史功能调整时只在该页面入口内补交互、按钮、表单或调用动作。'
        };
        const seen = new Set();
        return (Array.isArray(candidateFiles) ? candidateFiles : [])
            .map(file => {
                const fileKind = String(file && file.fileKind || '').trim();
                const filePath = String(file && file.resolvedPath || file && file.path || '').trim();
                const key = `${fileKind}::${filePath}`;
                if (!fileKind || !filePath || seen.has(key)) return null;
                seen.add(key);
                return {
                    fileKind,
                    path: filePath,
                    businessObject: String(file && file.businessObject || '').trim(),
                    useWhen: useWhenByKind[fileKind] || '需要承载本需求对应业务逻辑时使用。'
                };
            })
            .filter(Boolean);
    }

    _buildDraftRouteCards(routeContracts = []) {
        return (Array.isArray(routeContracts) ? routeContracts : [])
            .map(contract => {
                const defaultActionName = String(contract && contract.defaultActionName || '').trim();
                const htmlPage = String(contract && contract.htmlPage || '').trim();
                const actionNames = Array.isArray(contract && contract.actionNames) ? contract.actionNames : [];
                if (!htmlPage && !defaultActionName && actionNames.length === 0) return null;
                return {
                    htmlPage,
                    defaultActionName,
                    actionNames,
                    executeParamContract: {
                        rule: 'epoint.execute 不是通用 Ajax；不要套用 axios/fetch/$.ajax 的对象参数习惯。',
                        checklist: [
                            '跨 Action 写 action/method；裸 method 只走 initPage 默认 Action。',
                            '无提交控件用 @none；多个 Java public 参数按形参顺序传数组。',
                            '第三参禁止对象字面量，例如 { a: a, b: b }。'
                        ],
                        docRefs: ['references/company-practices/frontend/epoint-api-contract.md#epointexecute']
                    },
                    explicitActionRequired: contract && contract.explicitActionRequired === true,
                    allowedExecuteForms: Array.isArray(contract && contract.allowedExecuteForms)
                        ? contract.allowedExecuteForms
                        : [],
                    forbiddenExecuteForms: Array.isArray(contract && contract.forbiddenExecuteForms)
                        ? contract.forbiddenExecuteForms
                        : [],
                    pageRouteContract: this._buildCompactPageRouteContract(contract),
                    useWhen: '修改既有 HtmlPage 或新增 epoint.execute/refresh/action 调用前必须核对。',
                    rule: defaultActionName
                        ? `裸 epoint.execute('method') 只会路由到 ${defaultActionName}；方法写在其它 Action 时必须显式 action/method。`
                        : '未识别到页面 initPage 默认 Action 时，不要新增裸 epoint.execute。'
                };
            })
            .filter(Boolean);
    }

    _buildDraftBusinessFieldCards(businessFacts = {}) {
        const businessObjects = Array.isArray(businessFacts.businessObjects) ? businessFacts.businessObjects : [];
        const tables = Array.isArray(businessFacts.databaseTables) ? businessFacts.databaseTables : [];
        const statisticsContracts = Array.isArray(businessFacts.statisticsContracts) ? businessFacts.statisticsContracts : [];
        const workflowContracts = Array.isArray(businessFacts.workflowContracts) ? businessFacts.workflowContracts : [];
        return {
            businessObjects: businessObjects.map(item => ({
                businessObject: String(item && item.businessObject || '').trim(),
                entityName: String(item && item.entityName || '').trim(),
                ...(item && item.statisticsContract ? { statisticsContract: item.statisticsContract } : {}),
                ...(Array.isArray(item && item.statisticsContracts) && item.statisticsContracts.length > 0 ? { statisticsContracts: item.statisticsContracts } : {}),
                ...(item && item.workflowContract ? { workflowContract: item.workflowContract } : {}),
                ...(Array.isArray(item && item.workflowContracts) && item.workflowContracts.length > 0 ? { workflowContracts: item.workflowContracts } : {})
            })).filter(item => item.businessObject || item.entityName),
            statisticsContracts: statisticsContracts.map(item => item && typeof item === 'object' && !Array.isArray(item) ? item : null)
                .filter(Boolean),
            workflowContracts: workflowContracts.map(item => item && typeof item === 'object' && !Array.isArray(item) ? item : null)
                .filter(Boolean),
            tables: tables.map(table => {
                const reusedApis = uniqueNonEmptyStrings(table && table.reusedApis || []);
                const reuseDirHints = uniqueNonEmptyStrings(table && table.reuseDirHints || []);
                const reuseSourceFile = String(table && table.reuseSourceFile || '').trim();
                const isReuse = table && table.reuse === true;
                return {
                    tableName: String(table && table.tableName || '').trim(),
                    tableComment: String(table && table.tableComment || '').trim(),
                    primaryKey: String(table && table.primaryKey || '').trim(),
                    ...(isReuse ? { reuse: true } : {}),
                    ...(reusedApis.length > 0 ? { reusedApis } : {}),
                    ...(reuseSourceFile ? { reuseSourceFile } : {}),
                    ...(reuseDirHints.length > 0 ? { reuseDirHints } : {}),
                    ...((isReuse || reusedApis.length > 0 || reuseSourceFile || reuseDirHints.length > 0)
                        ? { readPolicy: '复用表先按 reuseSourceFile/reusedApis/reuseDirHints 的精确落点核对，不要凭表名搜索工程或编造 Service 方法。' }
                        : {}),
                    fields: (Array.isArray(table && table.businessColumns) ? table.businessColumns : [])
                    .map(column => ({
                        name: String(column && column.name || '').trim(),
                        comment: String(column && column.comment || '').trim(),
                        required: column && column.required === true,
                        type: String(column && column.type || '').trim(),
                        length: column && column.length !== undefined ? column.length : undefined,
                        codeItem: String(column && column.codeItem || '').trim(),
                        ...(column && column.attachmentKey === true ? {
                            attachmentKey: true,
                            attachmentLabel: String(column.attachmentLabel || column.comment || '').trim(),
                            attachmentRule: '本字段是附件稳定标识；按 GP-08 读取附件实践，上传、保存、详情回显、预览下载围绕同一标识闭合。'
                        } : {})
                    }))
                    .filter(column => column.name || column.comment)
                };
            }).filter(table => table.tableName || table.tableComment || table.fields.length > 0 || table.reuseSourceFile || (table.reusedApis || []).length > 0)
        };
    }

    _buildDraftRuleCheckCards(rulePool = {}) {
        const auditItems = Array.isArray(rulePool.selfAuditBeforeWrite) ? rulePool.selfAuditBeforeWrite : [];
        const hints = Array.isArray(rulePool.apiUsageHints) ? rulePool.apiUsageHints : [];
        const hintByRule = new Map();
        for (const hint of hints) {
            const ruleAlias = String(hint && hint.ruleAlias || '').trim();
            if (!ruleAlias || hintByRule.has(ruleAlias)) continue;
            hintByRule.set(ruleAlias, hint);
        }
        const cards = [];
        const seen = new Set();
        const pushCard = (ruleAlias, auditItem = {}, hint = {}) => {
            const alias = String(ruleAlias || '').trim();
            if (!alias || seen.has(alias)) return;
            seen.add(alias);
            cards.push({
                ruleAlias: alias,
                ...(hint.sourceFile ? { sourceFile: String(hint.sourceFile).trim() } : {}),
                ...(Array.isArray(hint.ruleRefs) && hint.ruleRefs.length > 0 ? { ruleRefs: hint.ruleRefs } : {}),
                askYourself: String(auditItem && auditItem.askYourself || '').trim()
                    || this._draftRuleQuestionFromHint(alias, hint),
                appliesToFileKinds: uniqueNonEmptyStrings(hint && hint.appliesToFileKinds || []),
                triggerTerms: uniqueNonEmptyStrings(hint && hint.triggerTerms || hint && hint.intentKeywords || []),
                candidates: this._draftRuleCandidates(hint),
                whenNeeded: `命中本规则时，先读 readCatalog.resources 登记的本地正文；本地正文缺失时才调用 rule_expert(action=read, ruleName="${alias}", outputMode=full)。`
            });
        };
        for (const auditItem of auditItems) {
            const ruleAlias = String(auditItem && auditItem.ruleAlias || '').trim();
            pushCard(ruleAlias, auditItem, hintByRule.get(ruleAlias) || {});
        }
        for (const hint of hints) {
            pushCard(String(hint && hint.ruleAlias || '').trim(), {}, hint);
        }
        return cards;
    }

    _buildDraftReuseGuideCards(reuseCard = null) {
        const slices = reuseCard && Array.isArray(reuseCard.codeSlices) ? reuseCard.codeSlices : [];
        const out = [];
        const seen = new Set();
        for (const slice of slices) {
            const actionClass = String(slice && slice.actionClass || '').trim();
            const methodName = String(slice && slice.methodName || '').trim();
            const htmlPage = String(slice && slice.htmlPage || '').trim();
            const frontendCall = String(slice && slice.frontendCall || '').trim();
            const key = `${htmlPage}::${actionClass}::${methodName}`;
            if (!methodName || seen.has(key)) continue;
            seen.add(key);
            out.push({
                guideType: 'historical_entry_method',
                useWhen: '修改历史入口前先核对：能复用既有入口方法、工具类调用、返回字段或关联实体时，优先在原路径延展，不要重造同类能力。',
                ...(htmlPage ? { htmlPage } : {}),
                ...(frontendCall ? { frontendCall } : {}),
                ...(slice && slice.routeKey ? { routeKey: String(slice.routeKey || '').trim() } : {}),
                ...(slice && slice.binding ? { binding: String(slice.binding || '').trim() } : {}),
                ...(actionClass ? { actionClass } : {}),
                ...(slice && slice.actionPath ? { actionPath: String(slice.actionPath || '').trim() } : {}),
                methodName,
                directCalls: this._buildDraftReuseDirectCalls(slice && slice.directCalls),
                relatedEntities: this._buildDraftReuseRelatedEntities(slice && slice.relatedEntities),
                callbackParams: uniqueNonEmptyStrings(slice && slice.callbackParams || []).slice(0, 8),
                responseFields: uniqueNonEmptyStrings(slice && slice.responseFields || []).slice(0, 12),
                evidence: uniqueNonEmptyStrings(slice && slice.evidence || []).slice(0, 6),
                readPolicy: '先读取本卡 actionPath、directCalls[].sourcePath、relatedEntities[].sourcePath；路径失效或证据不足时围绕类名/实体/调用方定向检索，方法签名以当前源码为准。'
            });
        }
        return out.slice(0, 12);
    }

    _buildDraftReuseTableGuideCards(businessFacts = {}, reuseTableGuide = null) {
        const tables = Array.isArray(businessFacts.databaseTables) ? businessFacts.databaseTables : [];
        const guideTables = new Map();
        for (const table of (reuseTableGuide && Array.isArray(reuseTableGuide.tables) ? reuseTableGuide.tables : [])) {
            const key = String(table && table.tableName || '').trim().toLowerCase();
            if (key && !guideTables.has(key)) guideTables.set(key, table);
        }
        const slices = reuseTableGuide && Array.isArray(reuseTableGuide.codeSlices) ? reuseTableGuide.codeSlices : [];
        const out = [];
        const seen = new Set();
        for (const table of tables) {
            const tableName = String(table && table.tableName || '').trim();
            const tableComment = String(table && table.tableComment || '').trim();
            const key = tableName.toLowerCase();
            const guideTable = guideTables.get(key) || {};
            const reusedApis = uniqueNonEmptyStrings(table && table.reusedApis || guideTable.reusedApis || []);
            const reuseSourceFile = String(table && table.reuseSourceFile || guideTable.reuseSourceFile || '').trim();
            const reuseDirHints = uniqueNonEmptyStrings(table && table.reuseDirHints || guideTable.reuseDirHints || []);
            const isReuse = table && table.reuse === true;
            if (!isReuse && reusedApis.length === 0 && !reuseSourceFile && reuseDirHints.length === 0) continue;
            if (!tableName && !reuseSourceFile && reusedApis.length === 0) continue;
            const seenKey = `${tableName}::${reuseSourceFile}`;
            if (seen.has(seenKey)) continue;
            seen.add(seenKey);
            const historicalMethodHints = slices
                .filter(slice => this._sliceTouchesReuseTable(slice, tableName, reuseSourceFile))
                .map(slice => ({
                    guideType: 'historical_entry_method',
                    ...(slice.htmlPage ? { htmlPage: String(slice.htmlPage || '').trim() } : {}),
                    ...(slice.frontendCall ? { frontendCall: String(slice.frontendCall || '').trim() } : {}),
                    ...(slice.routeKey ? { routeKey: String(slice.routeKey || '').trim() } : {}),
                    ...(slice.binding ? { binding: String(slice.binding || '').trim() } : {}),
                    actionClass: String(slice.actionClass || '').trim(),
                    ...(slice.actionPath ? { actionPath: String(slice.actionPath || '').trim() } : {}),
                    methodName: String(slice.methodName || '').trim(),
                    directCalls: this._buildDraftReuseDirectCalls(slice.directCalls),
                    relatedEntities: this._buildDraftReuseRelatedEntities(slice.relatedEntities),
                    callbackParams: uniqueNonEmptyStrings(slice.callbackParams || []).slice(0, 8),
                    responseFields: uniqueNonEmptyStrings(slice.responseFields || []).slice(0, 12),
                    evidence: uniqueNonEmptyStrings(slice.evidence || []).slice(0, 6)
                }))
                .filter(item => item.methodName)
                .slice(0, 6);
            out.push({
                guideType: 'reuse_table',
                tableName,
                tableComment,
                ...(table && table.primaryKey ? { primaryKey: String(table.primaryKey || '').trim() } : {}),
                ...(reusedApis.length > 0 ? { reusedApis } : {}),
                ...(reuseSourceFile ? { reuseSourceFile } : {}),
                ...(reuseDirHints.length > 0 ? { reuseDirHints } : {}),
                ...(historicalMethodHints.length > 0 ? { historicalMethodHints } : {}),
                readPolicy: '先读 reuseSourceFile 或 historicalMethodHints 中的精确 actionPath/directCalls/relatedEntities 路径；导航不足时围绕当前实体和调用方定向检索，不编造方法名。'
            });
        }
        return out.slice(0, 12);
    }

    _buildDraftReuseFieldMappingCards({ dataAccessPlans = [], candidateFiles = [], businessFacts = {} } = {}) {
        const cards = [];
        const tablesByName = new Map((Array.isArray(businessFacts && businessFacts.databaseTables) ? businessFacts.databaseTables : [])
            .map(table => [String(table && table.tableName || '').trim().toLowerCase(), table])
            .filter(([tableName]) => tableName));
        for (const plan of (Array.isArray(dataAccessPlans) ? dataAccessPlans : [])) {
            const moduleId = String(plan && plan.moduleId || '').trim();
            const fieldIntent = plan && plan.fieldIntent && typeof plan.fieldIntent === 'object' ? plan.fieldIntent : null;
            if (!moduleId || !fieldIntent || fieldIntent.requiresSourceFieldMapping !== true) continue;
            if (plan.queryOnly !== true || String(plan.accessType || '').trim() !== 'reuse_query_list') continue;
            const sourcePath = String(plan && plan.entity && plan.entity.sourcePath || plan && plan.table && plan.table.reuseSourceFile || '').trim();
            if (!sourcePath) continue;
            const targetFiles = this._reuseListTargetFilesForModule(candidateFiles, moduleId);
            if (targetFiles.length === 0) continue;
            const tableName = String(plan && plan.table && plan.table.tableName || '').trim();
            const table = tablesByName.get(tableName.toLowerCase()) || {};
            const sourceFieldCandidates = uniqueNonEmptyStrings([
                ...(Array.isArray(fieldIntent.sourceFieldCandidates) ? fieldIntent.sourceFieldCandidates : []),
                ...(Array.isArray(table && table.businessColumns) ? table.businessColumns.map(col => col && col.name) : [])
            ]).slice(0, 40);
            const businessDisplayLabels = uniqueNonEmptyStrings(fieldIntent.displayLabels || []);
            const businessQueryLabels = uniqueNonEmptyStrings(fieldIntent.queryLabels || []);
            const businessDetailLabels = uniqueNonEmptyStrings(fieldIntent.detailLabels || []);
            if (businessDisplayLabels.length === 0 && businessQueryLabels.length === 0 && businessDetailLabels.length === 0) continue;
            cards.push({
                cardType: 'reuse_field_mapping',
                moduleId,
                tableName,
                tableComment: String(plan && plan.table && plan.table.tableComment || table && table.tableComment || '').trim(),
                entityName: String(plan && plan.entity && plan.entity.className || plan && plan.table && plan.table.entityName || '').trim(),
                reuseSourceFile: sourcePath,
                targetFiles,
                ...(businessDisplayLabels.length > 0 ? { businessDisplayLabels } : {}),
                ...(businessQueryLabels.length > 0 ? { businessQueryLabels } : {}),
                ...(businessDetailLabels.length > 0 ? { businessDetailLabels } : {}),
                ...(sourceFieldCandidates.length > 0 ? { sourceFieldCandidates } : {}),
                mustDo: [
                    '先 read_file 读取 reuseSourceFile 指向的复用实体源码，核对真实字段、getter/setter 和继承字段。',
                    '基于源码证据把 businessDisplayLabels / businessQueryLabels / businessDetailLabels 映射到真实实体字段；不要让 Builder/Python 骨架的字段名兜底替代业务判断。',
                    '不能映射的业务字段不得编造数据库字段；说明它可能来自 JSON 入参/出参解析、历史接口返回或需要回需求确认。',
                    '映射完成后同步 patch targetFiles 中的 HtmlPage 列头/查询控件、Action 查询条件和 ExportModel 导出 fields/headers。'
                ],
                doNot: [
                    '不要把 api_url/input_params/output_params/call_status 等原始字段名直接当用户可见中文表头。',
                    '不要新增 IGxh{当前模块}Service 或当前模块 Entity 来替代已确认的复用实体。',
                    '不要 file_search/list_directory/search_by_regex 搜工程；只读本卡 reuseSourceFile 和 targetFiles。'
                ]
            });
        }
        return cards;
    }

    _reuseListTargetFilesForModule(candidateFiles = [], moduleId = '') {
        const targetModule = String(moduleId || '').trim();
        const out = [];
        const seen = new Set();
        for (const file of (Array.isArray(candidateFiles) ? candidateFiles : [])) {
            const fileModuleId = String(file && file.moduleId || file && file.evidenceRef || '').trim();
            if (fileModuleId && targetModule && fileModuleId !== targetModule) continue;
            const fileKind = String(file && file.fileKind || '').trim();
            if (fileKind !== 'Action' && fileKind !== 'HtmlPage') continue;
            const subType = String(file && file.subType || '').trim().toLowerCase();
            if (subType && subType !== 'list') continue;
            const resolvedPath = String(file && file.resolvedPath || file && file.path || '').trim();
            if (!resolvedPath || seen.has(resolvedPath)) continue;
            seen.add(resolvedPath);
            out.push({
                fileKind,
                ...(subType ? { subType } : { subType: 'list' }),
                path: resolvedPath
            });
        }
        return out;
    }

    _reuseFieldMappingCardsForStory(cards = [], story = {}, acceptanceItems = []) {
        if (!Array.isArray(cards) || cards.length === 0) return [];
        const storyModuleIds = new Set();
        const add = value => {
            const text = String(value || '').trim();
            if (text) storyModuleIds.add(text);
        };
        add(story && story.sourceModuleId);
        (Array.isArray(acceptanceItems) ? acceptanceItems : []).forEach(item => {
            add(item && item.sourceModuleId);
        });
        return cards.filter(card => {
            const moduleId = String(card && card.moduleId || '').trim();
            if (!moduleId) return false;
            return storyModuleIds.size === 0 || storyModuleIds.has(moduleId);
        });
    }

    _sliceTouchesReuseTable(slice = {}, tableName = '', reuseSourceFile = '') {
        const tableKey = String(tableName || '').trim().toLowerCase();
        const sourceKey = String(reuseSourceFile || '').replace(/\\/g, '/').toLowerCase();
        return (Array.isArray(slice.relatedEntities) ? slice.relatedEntities : []).some(entity => {
            const entityTable = String(entity && entity.tableName || '').trim().toLowerCase();
            const entitySource = String(entity && entity.sourcePath || '').replace(/\\/g, '/').toLowerCase();
            return (tableKey && entityTable === tableKey) || (sourceKey && entitySource === sourceKey);
        });
    }

    _buildDraftReuseDirectCalls(items = []) {
        return (Array.isArray(items) ? items : [])
            .map(item => {
                const ownerName = String(item && item.ownerName || '').trim();
                const methodName = String(item && item.methodName || '').trim();
                if (!ownerName || !methodName) return null;
                return {
                    ...(item && item.callType ? { callType: String(item.callType || '').trim() } : {}),
                    ownerName,
                    methodName,
                    ...(item && item.fieldName ? { fieldName: String(item.fieldName || '').trim() } : {}),
                    ...(item && item.sourceKind ? { sourceKind: String(item.sourceKind || '').trim() } : {}),
                    ...(item && item.sourcePath ? { sourcePath: String(item.sourcePath || '').trim() } : {}),
                    ...(item && item.ruleAlias ? { ruleAlias: String(item.ruleAlias || '').trim() } : {})
                };
            })
            .filter(item => item && Object.values(item).some(value => String(value || '').trim()))
            .slice(0, 12);
    }

    _buildDraftReuseRelatedEntities(items = []) {
        return (Array.isArray(items) ? items : [])
            .map(item => {
                const entityName = String(item && item.entityName || '').trim();
                if (!entityName) return null;
                return {
                    entityName,
                    ...(item && item.tableName ? { tableName: String(item.tableName || '').trim() } : {}),
                    ...(item && item.sourcePath ? { sourcePath: String(item.sourcePath || '').trim() } : {})
                };
            })
            .filter(item => item && Object.values(item).some(value => String(value || '').trim()))
            .slice(0, 8);
    }

    _draftRuleQuestionFromHint(ruleAlias, hint = {}) {
        const terms = uniqueNonEmptyStrings(hint.triggerTerms || hint.intentKeywords || []).slice(0, 4);
        if (terms.length > 0) return `本段代码是否涉及 ${terms.join(' / ')}？`;
        return `本段代码是否涉及 ${ruleAlias}？`;
    }

    _draftRuleCandidates(hint = {}) {
        const methods = Array.isArray(hint.methods) ? hint.methods : [];
        const actions = Array.isArray(hint.actions) ? hint.actions : [];
        const owner = String(hint && (hint.interfaceName || hint.capabilityId || hint.ruleAlias) || '').trim();
        const out = [];
        methods.slice(0, 4).forEach(item => {
            const name = String(item && item.name || '').trim();
            const signature = String(item && item.signature || '').trim();
            out.push({
                ...(owner ? { owner } : {}),
                name,
                method: name,
                signature,
                ...(this._buildDraftCallShape(owner, name, signature) ? { callShape: this._buildDraftCallShape(owner, name, signature) } : {}),
                summary: String(item && item.summary || '').trim()
            });
        });
        actions.slice(0, 4).forEach(item => {
            const method = String(item && item.method || '').trim();
            out.push({
                ...(owner ? { owner } : {}),
                name: String(item && item.name || '').trim(),
                method,
                ...(this._buildDraftCallShape(owner, method, '') ? { callShape: this._buildDraftCallShape(owner, method, '') } : {})
            });
        });
        if (out.length === 0 && hint && hint.summary) {
            out.push({ summary: String(hint.summary || '').trim() });
        }
        return out.filter(item => Object.values(item).some(value => String(value || '').trim()));
    }

    _buildDraftCallShape(owner = '', methodName = '', signature = '') {
        const ownerText = String(owner || '').trim();
        const method = String(methodName || '').trim();
        const sig = String(signature || '').trim();
        if (!method) return '';
        if (/^[A-Za-z_$][\w$]*\s*\(/.test(sig)) return sig;
        if (!ownerText) return `${method}(...)`;
        return `${ownerText}.${method}(...)`;
    }

    _collectRequirementUserStories(facts, planJson) {
        const stories = [];
        const seen = new Set();
        const pushStory = (story) => {
            const storyId = String(story && story.storyId || story && story.id || '').trim().toUpperCase();
            const userStory = String(story && story.userStory || story && story.description || '').trim();
            if (!storyId || !userStory || seen.has(storyId)) return;
            seen.add(storyId);
            stories.push({
                storyId,
                userStory,
                ...(story.actor ? { actor: String(story.actor).trim() } : {}),
                invariants: Array.isArray(story.invariants) ? story.invariants : [],
                acceptanceCriteria: this._normalizeStoryAcceptanceCriteria(story.acceptanceCriteria),
                ruleRefs: Array.isArray(story.ruleRefs) ? story.ruleRefs : [],
                ...this._codingFactHandoffProjection(story),
                ...this._existingAdjustmentProjection(story)
            });
        };
        const factStories = facts && facts.stories && typeof facts.stories === 'object' ? facts.stories : {};
        Object.values(factStories).forEach(pushStory);
        const planStories = planJson && planJson.requirementWorkPackage && Array.isArray(planJson.requirementWorkPackage.userStories)
            ? planJson.requirementWorkPackage.userStories
            : [];
        planStories.forEach(pushStory);
        const modules = facts && facts.modules && typeof facts.modules === 'object' ? facts.modules : {};
        Object.values(modules).forEach(moduleFacts => {
            if (Array.isArray(moduleFacts && moduleFacts.relatedStories)) {
                moduleFacts.relatedStories.forEach(pushStory);
            }
        });
        return stories;
    }

    _codingFactHandoffProjection(story = {}) {
        const raw = Array.isArray(story && story.codingFactHandoff) ? story.codingFactHandoff : [];
        const out = [];
        const seen = new Set();
        raw.forEach(item => {
            const normalized = this._normalizeCodingFactHandoffItem(item);
            if (!normalized) return;
            const key = `${normalized.factId || ''}::${normalized.factType || ''}::${normalized.description || ''}`;
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

    _normalizeStoryAcceptanceCriteria(ac = {}) {
        const groups = getAcceptanceGroups(ac || {});
        return {
            happyPath: this._normalizeStoryAcceptanceGroup(groups.happyPath),
            exception: this._normalizeStoryAcceptanceGroup(groups.exception),
            boundary: this._normalizeStoryAcceptanceGroup(groups.boundary)
        };
    }

    _normalizeStoryAcceptanceGroup(items = []) {
        return (Array.isArray(items) ? items : []).map((item, index) => ({
            code: String(item && item.code || '').trim(),
            group: String(item && item.group || '').trim(),
            scenario: String(item && item.scenario || `item-${index + 1}`).trim(),
            given: String(item && item.given || '').trim(),
            when: String(item && item.when || '').trim(),
            then: String(item && item.then || '').trim(),
            ...(item && item.storyId ? { storyId: String(item.storyId || '').trim().toUpperCase() } : {}),
            ...(item && item.userStory ? { userStory: String(item.userStory || '').trim() } : {}),
            ...(item && item.sourceStoryId ? { sourceStoryId: String(item.sourceStoryId || '').trim().toUpperCase() } : {}),
            ...(item && item.sourceType ? { sourceType: String(item.sourceType || '').trim() } : {}),
            ...(item && item.sourceModuleId ? { sourceModuleId: String(item.sourceModuleId || '').trim() } : {})
        })).filter(item => item.scenario || item.given || item.when || item.then || item.code);
    }

    _buildDraftStoryAcceptanceItems(story = {}) {
        return flattenAcceptanceItems(story.acceptanceCriteria || {})
            .map(entry => {
                const item = entry.item || {};
                return {
                    code: entry.code,
                    group: entry.group,
                    scenario: String(item.scenario || '').trim(),
                    given: String(item.given || '').trim(),
                    when: String(item.when || '').trim(),
                    then: String(item.then || '').trim(),
                    storyId: String(item.storyId || item.sourceStoryId || '').trim().toUpperCase(),
                    userStory: String(item.userStory || '').trim(),
                    sourceModuleId: String(item.sourceModuleId || '').trim()
                };
            })
            .filter(item => item.code || item.scenario || item.given || item.when || item.then);
    }

    _dedupeCandidateFiles(candidateFiles = []) {
        const out = [];
        const seen = new Set();
        for (const file of (Array.isArray(candidateFiles) ? candidateFiles : [])) {
            const fileKind = String(file && file.fileKind || '').trim();
            const resolvedPath = String(file && file.resolvedPath || file && file.path || '').trim();
            if (!fileKind || !resolvedPath) continue;
            const key = `${fileKind}::${resolvedPath}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ ...file, fileKind, resolvedPath });
        }
        return out;
    }

    _resolvePathInsideProject(projectPath = '', rawPath = '') {
        const projectRoot = String(projectPath || '').trim() ? path.resolve(String(projectPath || '').trim()) : '';
        const inputPath = String(rawPath || '').trim();
        if (!projectRoot || !inputPath || inputPath.indexOf('\0') !== -1) return '';
        const resolvedPath = path.isAbsolute(inputPath)
            ? path.resolve(inputPath)
            : path.resolve(projectRoot, inputPath);
        return this._isSameOrChild(resolvedPath, projectRoot) ? resolvedPath : '';
    }

    _collectHistoricalEntryCandidateFiles(facts = {}, userStories = [], normalizedProject = '') {
        const allowed = new Set(['HtmlPage', 'Action']);
        const out = [];
        const seen = new Set();
        const pushEntry = (entry = {}, storyId = '') => {
            const fileKind = String(entry.fileKind || '').trim();
            const rawPath = String(entry.resolvedPath || entry.path || entry.filePath || '').trim();
            const resolvedPath = this._resolvePathInsideProject(normalizedProject, rawPath);
            if (!allowed.has(fileKind) || !resolvedPath) return;
            const key = `${fileKind}::${resolvedPath}`;
            if (seen.has(key)) return;
            seen.add(key);
            out.push({
                storyId: String(entry.storyId || storyId || '').trim().toUpperCase(),
                fileKind,
                resolvedPath,
                operation: 'modify',
                source: String(entry.source || 'stories.existingAdjustment.entryFiles').trim() || 'stories.existingAdjustment.entryFiles'
            });
        };
        (Array.isArray(facts.historicalEntryFiles) ? facts.historicalEntryFiles : []).forEach(entry => pushEntry(entry, entry && entry.storyId));
        userStories.forEach(story => {
            const storyId = String(story && story.storyId || '').trim().toUpperCase();
            const entryFiles = story && story.existingAdjustment && Array.isArray(story.existingAdjustment.entryFiles)
                ? story.existingAdjustment.entryFiles
                : [];
            entryFiles.forEach(entry => pushEntry(entry, storyId));
        });
        return out;
    }

    _collectHistoricalBehaviorCards(facts = {}, userStories = []) {
        const out = [];
        const seen = new Set();
        const pushItem = (item = {}, storyId = '') => {
            const normalizedStoryId = String(item.storyId || storyId || '').trim().toUpperCase();
            const businessResult = String(item.businessResult || '').trim();
            const regressionScope = String(item.regressionScope || '').trim();
            if (!normalizedStoryId || !businessResult) return;
            const key = `${normalizedStoryId}::${businessResult}::${regressionScope}`;
            if (seen.has(key)) return;
            seen.add(key);
            out.push({
                storyId: normalizedStoryId,
                businessResult,
                ...(regressionScope ? { regressionScope } : {}),
                source: String(item.source || 'stories.existingAdjustment.preserveBehaviors').trim() || 'stories.existingAdjustment.preserveBehaviors'
            });
        };
        (Array.isArray(facts.historicalBehaviorFacts) ? facts.historicalBehaviorFacts : []).forEach(item => pushItem(item));
        userStories.forEach(story => {
            const storyId = String(story && story.storyId || '').trim().toUpperCase();
            const preserveBehaviors = story && story.existingAdjustment && Array.isArray(story.existingAdjustment.preserveBehaviors)
                ? story.existingAdjustment.preserveBehaviors
                : [];
            preserveBehaviors.forEach(item => pushItem(item, storyId));
        });
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

    /**
     * 由 normalizedProject + .active-demand 推 business-facts.json 的固定路径。
     */
    _resolveBusinessFactsPath(normalizedProject) {
        try {
            const projectArtifactsDir = path.join(normalizedProject, '.ai-workspace', 'project');
            const activeDemandPath = path.join(projectArtifactsDir, '.active-demand');
            if (!fs.existsSync(activeDemandPath)) return '';
            const demandName = String(fs.readFileSync(activeDemandPath, 'utf-8') || '').trim();
            if (!demandName) return '';
            return path.join(projectArtifactsDir, demandName, 'code', 'business-facts.json');
        } catch (_) {
            return '';
        }
    }

    /**
     * 与计划共用模板解析，不维护第二份映射。
     */
    _defaultSectionKeyForFileKind(fileKind, fileEntry) {
        return resolveSkeletonSectionKey(fileKind, fileEntry);
    }

    _validateSkeletonDependencyBindings({ normalizedProject = '', normalizedTarget = '', fileKind = '' } = {}) {
        const planPath = this._resolvePlanJsonPath(normalizedProject);
        if (!planPath || !fs.existsSync(planPath)) {
            return this._blocked('DESIGN_TDD_SKELETON_DEPENDENCY_GRAPH_MISSING', '缺少 design-tdd-plan.json，无法验证骨架依赖图。');
        }
        const plan = this._readJson(planPath);
        const graph = plan && plan.skeletonDependencyGraph;
        if (!graph || !Array.isArray(graph.targetBindings)) {
            return this._blocked(
                'DESIGN_TDD_SKELETON_DEPENDENCY_GRAPH_MISSING',
                '当前设计计划没有骨架依赖图，禁止按旧的文件名推测规则继续物化。',
                { allowedNextActions: ['rerun_design_tdd_build_plan'] }
            );
        }
        const normalize = value => path.resolve(String(value || '')).replace(/\\/g, '/').toLowerCase();
        const identity = String(fileKind || '').trim() + ':' + normalize(normalizedTarget);
        const binding = graph.targetBindings.find(item => String(item && item.providerFileIdentity || '').trim() === identity);
        if (!binding) {
            return this._blocked(
                'DESIGN_TDD_SKELETON_TYPE_BINDING_MISSING',
                `目标 ${normalizedTarget} 不在骨架依赖图中，禁止由文件名猜测上游类型。`,
                { targetFile: normalizedTarget, allowedNextActions: ['rerun_design_tdd_build_plan'] }
            );
        }
        const ledgerPath = path.join(path.dirname(planPath), 'skeleton-manifests-ledger.json');
        const ledger = this._readJson(ledgerPath) || {};
        const entries = Array.isArray(ledger.entries) ? ledger.entries : [];
        const materialized = new Map(entries.map(entry => [normalize(entry && entry.targetFile), entry]));
        const state = this._readJson(path.join(path.dirname(planPath), 'code-state.json')) || {};
        const retainedTargets = new Set(Array.isArray(state.skeleton?.materializedTargets) ? state.skeleton.materializedTargets : []);
        const missing = [];
        (Array.isArray(binding.requiredTypeBindings) ? binding.requiredTypeBindings : []).forEach(required => {
            const provider = materialized.get(normalize(String(required && required.providerFileIdentity || '').split(':').slice(1).join(':')));
            if (!provider && !(retainedTargets.has(required.providerFileIdentity)
                && required.resolvedPath && fs.existsSync(required.resolvedPath))) missing.push({
                kind: 'type',
                providerFileIdentity: required.providerFileIdentity,
                expectedType: required.expectedType
            });
        });
        // requiredMethodBindings 不作物化前置校验：
        // 1. 统计契约方法（queryStatisticsData 等）由 Vibe Coding 阶段实现，骨架只负责机械结构，
        //    把"业务方法是否已生成"当物化门禁与骨架定位矛盾；
        // 2. 历史版本把 method 边绑到模块内全部文件（含 ServiceApi/ServiceInternal 自身），
        //    ServiceApi(先物化) → ServiceInternal(method provider) → ServiceApi(type) 形成环，
        //    批次物化 35/35 全量死锁。type 边已完整表达物化顺序，method 边仅作编码阶段信息保留。
        if (missing.length > 0) {
            return this._blocked(
                'DESIGN_TDD_SKELETON_TYPE_BINDING_MISSING',
                `目标 ${normalizedTarget} 的上游依赖尚未发布到 skeleton ledger，禁止继续物化。`,
                { targetFile: normalizedTarget, missingBindings: missing, allowedNextActions: ['materialize_upstream_skeleton_then_retry'] }
            );
        }
        return { ok: true, binding };
    }

    /**
     * 步骤1：构造 nextStep.businessFactsRef —— 指向 build_plan 统一落盘的业务事实索引。
     * 物化返回只给指针和 layerContract，避免同一模块的 databaseTables / acceptanceCriteria /
     * rulePool 在每个骨架文件返回里重复灌入 LLM 上下文。
     */
    _buildNextStepBusinessFacts({ normalizedProject, moduleId, fileKind, targetFile }) {
        try {
            const projectArtifactsDir = path.join(normalizedProject, '.ai-workspace', 'project');
            const activeDemandPath = path.join(projectArtifactsDir, '.active-demand');
            if (!fs.existsSync(activeDemandPath)) return null;
            const demandName = String(fs.readFileSync(activeDemandPath, 'utf-8') || '').trim();
            if (!demandName) return null;
            const demandDir = path.resolve(projectArtifactsDir, demandName);
            const designJsonPath = path.join(demandDir, 'design', '设计文档.json');
            if (!fs.existsSync(designJsonPath)) return null;
            const designJson = this._readJson(designJsonPath);
            if (!designJson || !Array.isArray(designJson.modules)) return null;
            const module = designJson.modules.find(m => String(m && m.moduleId || '').trim() === moduleId);
            if (!module) return null;

            // 检查 business-facts.json 是否已落盘——这是 build_plan 的产物，按需读模式
            const businessFactsPath = path.join(demandDir, 'code', 'business-facts.json');
            const businessFactsExists = fs.existsSync(businessFactsPath);

            // AGENTS.md "返回瘦身"：MOD-01 一个聚合要物化 6 个文件，老方案每次都返回完整
            // databaseTables / acceptanceCriteria / selfAuditBeforeWrite / confirmedRules（~7k 字符），
            // 7 步累计 60k+ 字符灌进 LLM 上下文，且 90% 内容重复（同模块事实不变）。
            // 修法：build_plan 一次性把所有模块业务事实落到 business-facts.json，物化主返回
            // 只给 businessFactsRef 指针 + readWhen 触发条件，LLM 自觉按需 read_file。
            if (businessFactsExists) {
                return {
                    actionMode: 'fill_business_logic_from_business_facts_ref',
                    moduleId,
                    fileKind,
                    targetFile,
                    layerContract: this._buildLayerContract(fileKind),
                    businessFactsRef: {
                        path: businessFactsPath,
                        sourceModuleId: moduleId,
                        readWhen: [
                            '填 Entity/页面/查询条件业务字段时（看 businessFacts.databaseTables）',
                            '核对 Story 验收项时（看 acceptanceLedger.items，按 storyId/code 顺序施工；sourceModuleId=' + moduleId + ' 只作文件落点辅助，不作为验收主轴）',
                            '写每段业务代码前（先看 rulePool.apiUsageHints / selfAuditBeforeWrite；具体前后端小抄由 apiUsageCard 按 fileKind 筛选，再读 readCatalog.resources 登记的本地正文；本地正文缺失时才调 rule_expert）'
                        ],
                        note: '本次需求业务事实落盘在 path；Story 模式按需求整体读取 businessFacts/rulePool，验收账本以 storyId/code 为主轴，sourceModuleId 仅辅助定位文件和规则小抄。不需要每次重读，read_file 一次缓存到对话内即可。'
                    }
                };
            }
            return {
                moduleId,
                fileKind,
                targetFile,
                layerContract: this._buildLayerContract(fileKind),
                status: 'blocked',
                actionMode: 'repair_design_tdd_artifacts',
                errorCode: 'DESIGN_TDD_BUSINESS_FACTS_MISSING',
                instruction: `business-facts.json 不存在：${businessFactsPath}。请先调 design_tdd_build_plan 生成业务事实索引，再物化骨架。`,
                forbiddenActions: [
                    'write_business_code_without_business_facts',
                    'view_design_json_to_reconstruct_business_facts'
                ]
            };
        } catch (_) {
            return null;
        }
    }

    _readRequirementConfirmedRules(demandDir = '') {
        try {
            const rulePoolPath = path.join(demandDir, 'demand', 'rule-pool.json');
            if (!fs.existsSync(rulePoolPath)) return [];
            const rulePool = this._readJson(rulePoolPath);
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
        } catch (_) {
            return [];
        }
    }

    /**
     * 构建当前 fileKind 在后端 4 层架构中的角色合同（Builder-owned 结构事实）。
     *
     * 故事线：LLM 物化 ServiceImpl 后看到一个空 @Component 类，凭印象自己发明
     * `private ICommonDao getDao() { return SpringContextUtil.getBean(...) }` —— 这是
     * 因为它不知道 ServiceImpl 是壳、真正的 DAO 持有者是 ServiceInternal。
     *
     * 修法：物化时直接告诉 LLM 当前 fileKind 是什么角色、调谁、谁调它，让它没机会凭印象。
     * 这是规则模板硬性约定（参考 950以下/代码生成规范-后端实体层.md），不是业务判断。
     *
     * 仅对后端 4 件套返回，HtmlPage / Action 不涉及分层歧义，返回 null。
     */
    _buildLayerContract(fileKind) {
        const kind = String(fileKind || '').trim();
        const map = {
            Entity: {
                role: '数据库实体（POJO + super.set/super.get）',
                responsibility: '声明业务字段的 getter/setter，全部走 super.get("字段名") / super.set("字段名", value) 访问 BaseEntity 动态字段；严禁 private String xxx; this.xxx',
                consumes: [],
                consumedBy: ['ServiceInternal', 'ServiceApi', 'Action'],
                forbidden: ['private 业务字段 + this.xxx 读写', '使用 com.epoint.basic.entity 旧模型包', '@Autowired / @Resource 注入']
            },
            ServiceApi: {
                role: '接口层（IGxh{EntityName}Service）',
                responsibility: '只声明方法签名，不写实现；CRUD 基础方法 + 业务扩展方法',
                consumes: ['Entity'],
                consumedBy: ['ServiceImpl', 'Action'],
                forbidden: ['有任何方法体', '依赖具体实现类', '出现 ICommonDao 引用']
            },
            ServiceInternal: {
                role: '内部逻辑层（Gxh{EntityName}Service，干活的真主）',
                responsibility: '持有 protected ICommonDao baseDao，构造器内 baseDao = CommonDao.getInstance()；所有 DAO 调用、SQL 拼接、业务规则都在这一层；本类不实现任何接口',
                consumes: ['Entity', 'ICommonDao'],
                consumedBy: ['ServiceImpl'],
                daoInjection: 'protected ICommonDao baseDao;\\npublic Gxh{EntityName}Service() { baseDao = CommonDao.getInstance(); }',
                forbidden: ['@Autowired ICommonDao', 'SpringContextUtil.getBean(ICommonDao.class)', '@Component / @Service 注解', '实现 IGxh{EntityName}Service 接口']
            },
            ServiceImpl: {
                role: '外壳层（Gxh{EntityName}ServiceImpl，仅做转发）',
                responsibility: '@Component 注解 + implements IGxh{EntityName}Service；每个方法体只一行：return new Gxh{EntityName}Service().xxx(record); 不持有任何字段，不写业务逻辑，不注入 DAO',
                consumes: ['ServiceApi（接口契约）', 'ServiceInternal（实际逻辑）'],
                consumedBy: ['Action'],
                bodyTemplate: '@Override public T method(args) { return new Gxh{EntityName}Service().method(args); }',
                forbidden: [
                    'private/protected ICommonDao 字段',
                    '@Autowired / @Resource 注入',
                    'SpringContextUtil.getBean(ICommonDao.class)',
                    '在方法体内写 SQL / DAO 调用 / 业务规则',
                    '声明任何成员变量（除非是常量）'
                ]
            },
            Rest: {
                role: '对外 REST 接口控制器',
                responsibility: '承载对外接口请求解析、参数校验和统一返回封装；调用 ServiceApi，不直接写 DAO / SQL / 页面回调逻辑',
                consumes: ['ServiceApi', 'rest-interface-style.contract.json'],
                consumedBy: ['外部系统或调用方'],
                forbidden: ['复用管理端 Action 模板', '绕过 rest-interface-style.contract.json 自造返回结构', '直接操作 ICommonDao']
            },
            Job: {
                role: '定时任务入口',
                responsibility: '只承载调度入口、日志和异常抛出；通过 ContainerFactory 获取 ServiceApi 并调用业务方法，业务逻辑落在 ServiceInternal/ServiceImpl 链路',
                consumes: ['ServiceApi', '定时任务Job开发规范'],
                consumedBy: ['Quartz 调度器'],
                forbidden: ['把用户可见查询页面塞进 Job 文件', '在 Job 里直接写 DAO / SQL', '@Autowired 注入 Service']
            },
            Action: {
                role: '控制层（Gxh{EntityName}{Operation}Action）',
                responsibility: '@RestController 入口 + 调 ServiceApi（不直接调 ServiceInternal）+ EUI 回调；UserSession / SqlConditionUtil / addCallbackParam 按规则用',
                consumes: ['ServiceApi', 'UserSession', 'SqlConditionUtil'],
                consumedBy: ['HtmlPage（前端 ajax 调本 Action）'],
                forbidden: ['直接 new ServiceInternal()', '直接持有 ICommonDao', '@Autowired ICommonDao']
            }
        };
        return map[kind] || null;
    }

    /**
     * 读 <demandDir>/code/relevant-rules.json，按 moduleId 取规则元数据，渲染成自审清单。
     *
     * 输出形状（每条对应一条规则）：
     *   {
     *     ruleAlias: "UserSession使用规范",
     *     askYourself: "本段代码是否涉及 用户会话/用户信息/UserSession ...？",
     *     ifYes: "先看 apiUsageCard/ruleRefs 和 readCatalog 本地正文；本地正文缺失时才调 rule_expert(read)",
     *     ifNo: "跳过本条",
     *     ruleFilePath: "...",                  // 给 LLM 备查
     *     description: "...",                    // 规则一句话定位
     *     intentKeywords: [...]                  // askYourself 里的语义信号
     *   }
     *
     * 失败容忍：缺 relevant-rules.json / 缺当前 moduleId / 缺规则元数据时返回空数组。
     * 不阻断 nextStep 主路径——LLM 缺失自审清单时退化为"靠 confirmedRules 名字自己 rule_expert"。
     */
    _buildSelfAuditChecklist({ demandDir, moduleId, fileKind }) {
        try {
            if (!demandDir || !moduleId) return [];
            const relevantRulesPath = path.join(demandDir, 'code', 'relevant-rules.json');
            if (!fs.existsSync(relevantRulesPath)) return [];
            const data = this._readJson(relevantRulesPath);
            if (!data || !data.modules || typeof data.modules !== 'object') return [];
            const rules = this._relevantRulesForModule(data, moduleId);
            if (rules.length === 0) return [];

            return rules
                .filter(rule => rule && rule.ruleAlias && rule.foundStatus !== 'not_found')
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
                        ifYes: `先看 apiUsageCard/ruleRefs 和 readCatalog.resources 登记的本地正文；本地正文缺失时才调 rule_expert(action=read, ruleName="${ruleAlias}", outputMode=full)`,
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

    _slimMaterializeResult(result = {}) {
        // AGENTS.md "返回瘦身"红线：只保留 LLM 下一步可消费的字段。
        // 删掉的字段：
        //   - input / manifest 路径：新主线不再暴露或生成源码同目录 manifest
        //   - materializedFiles[].methodSignatures：完整 typed signatures 信息量太大，LLM 只消费骨架入口
        //     测试需要的方法名信息由 business-facts.json / apiUsageCard 提供；事后审计细节在 skeleton-manifests-ledger
        //   - status 默认值表达里的"blocked"分支：失败时主返回的 errorCode/message 已经更明确
        const materializedFiles = Array.isArray(result.materializedFiles) ? result.materializedFiles : [];
        const projectionFailure = result.ok !== true && result.fallbackDetail
            && result.fallbackDetail.errorCode === 'DESIGN_TDD_SKELETON_TYPE_PROJECTION_MISMATCH'
            ? result.fallbackDetail : null;
        return {
            ok: result.ok === true,
            status: result.status || 'materialized',
            ...(projectionFailure ? { errorCode: projectionFailure.errorCode, message: projectionFailure.message } : {}),
            ...(Array.isArray(result.errors) && result.errors.length > 0
                ? { errors: result.errors }
                : {}),
            materializedFiles: materializedFiles.map(file => ({
                targetFile: file.targetFile || file.filePath || '',
                fileKind: file.fileKind || '',
                ...(file.responseStyle ? { responseStyle: file.responseStyle } : {}),
                ...(Array.isArray(file.dependencyPatches) && file.dependencyPatches.length > 0
                    ? { dependencyPatches: file.dependencyPatches }
                    : {})
            }))
        };
    }

    _buildBuiltinContextMissingBlockedResult(result = {}, context = {}) {
        const fallbackReason = String(result && result.fallbackReason || result && result.status || '').trim();
        if (fallbackReason !== 'fallback_builtin_context_missing') return null;
        const detail = result && result.fallbackDetail && typeof result.fallbackDetail === 'object' && !Array.isArray(result.fallbackDetail)
            ? result.fallbackDetail
            : (result && result.manifest && result.manifest.fallbackDetail && typeof result.manifest.fallbackDetail === 'object' && !Array.isArray(result.manifest.fallbackDetail)
                ? result.manifest.fallbackDetail
                : {});
        const rawMessage = String(
            detail.message ||
            result.fallbackMessage ||
            (result.manifest && result.manifest.fallbackMessage) ||
            ''
        ).trim();
        const errorCode = String(detail.errorCode || '').trim() || (
            /WORKFLOW_BUILTIN_CONTEXT_MISSING/.test(rawMessage)
                ? 'WORKFLOW_BUILTIN_CONTEXT_MISSING'
                : 'BUILTIN_CONTEXT_MISSING'
        );
        const missingFields = Array.isArray(detail.missingFields)
            ? detail.missingFields.map(item => String(item || '').trim()).filter(Boolean)
            : this._extractMissingFieldsFromBuiltinMessage(rawMessage);
        if (errorCode !== 'WORKFLOW_BUILTIN_CONTEXT_MISSING') {
            return {
                ok: false,
                status: 'blocked',
                actionMode: 'repair_builtin_skeleton_context',
                errorCode,
                message: rawMessage || '内置骨架缺少必要上下文，无法物化。',
                fallbackReason,
                missingFields,
                targetFile: String(context.targetFile || result.targetFile || '').trim(),
                fileKind: String(context.fileKind || '').trim(),
                sectionKey: String(context.sectionKey || '').trim()
            };
        }
        return {
            ok: false,
            status: 'blocked',
            actionMode: 'builder_projection_defect',
            errorCode: 'DESIGN_TDD_TARGET_PROJECTION_DEFECT',
            defectOwner: 'Builder',
            message: `${rawMessage || '工作流骨架缺少必要上下文。'} 当前Coder不能猜测流程承载关系；请通过同一目标投影入口修复稳定关系。`,
            reason: 'workflow_builtin_context_missing',
            fallbackReason,
            missingFields,
            moduleId: String(context.moduleId || '').trim(),
            targetFile: String(context.targetFile || result.targetFile || '').trim(),
            fileKind: String(context.fileKind || '').trim(),
            sectionKey: String(context.sectionKey || '').trim(),
            nextActionCard: {
                toolName: 'host_coder_vibecoding',
                argumentsShape: {
                    projectPath: String(context.projectPath || '').trim(),
                    codingMode: 'vibe_coding'
                },
                instruction: '保持当前需求事实和骨架，修复上游投影后由 Coder 重新读取完整需求并在本地计划中记录，不调用旧 Story MCP。'
            },
            allowedNextActions: ['rerun_design_tdd_build_plan_then_start_direct_vibecoding'],
            forbiddenActions: [
                'continue_materialize_without_workflow_carrier',
                'hardcode_tableName_in_skeleton_substitutions',
                'write_design_state_directly'
            ]
        };
    }

    _extractMissingFieldsFromBuiltinMessage(message = '') {
        const text = String(message || '');
        const match = text.match(/必要上下文[:：]([^。；;\n]+)/u);
        if (!match) return [];
        return match[1]
            .split(/[,，]/u)
            .map(item => item.trim())
            .filter(Boolean);
    }

    _extractVersionBucket(frameworkBucket = {}) {
        return String(
            frameworkBucket.versionBucket ||
            frameworkBucket.bucket ||
            (frameworkBucket.frameworkBucket && frameworkBucket.frameworkBucket.bucket) ||
            ''
        ).trim();
    }

    _targetMatchesNavigationContract(targetFile, projectPath, navigationContract = {}, fileKind = '') {
        const paths = navigationContract.paths && typeof navigationContract.paths === 'object'
            ? navigationContract.paths
            : {};
        // HtmlPage 的路径模板既可能在 paths.web (旧 scan 契约)，也可能直接由
        // rulePlacementContract.rules[fileKind=HtmlPage].relativeDirPattern 给出（新链路）。
        // 这里两种都接住。
        const keyMap = {
            Action: ['action'],
            Entity: ['entity'],
            ServiceApi: ['service_api', 'serviceApi'],
            ServiceInternal: ['service_internal', 'serviceInternal', 'service_impl', 'serviceImpl'],
            ServiceImpl: ['service_impl', 'serviceImpl'],
            Rest: ['rest', 'rest_controller', 'restController'],
            Job: ['job', 'scheduled_job', 'scheduledJob'],
            HtmlPage: ['web', 'html_page', 'htmlPage', 'webapp']
        };
        const keys = keyMap[fileKind] || [];
        const candidates = [];
        for (const key of keys) {
            const template = String(paths[key] || '').trim();
            if (template) {
                candidates.push({ key, template });
            }
        }
        // 兜底：从 rulePlacementContract.rules 取 relativeDirPattern
        if (candidates.length === 0) {
            const rules = navigationContract
                && navigationContract.rulePlacementContract
                && Array.isArray(navigationContract.rulePlacementContract.rules)
                ? navigationContract.rulePlacementContract.rules
                : [];
            const placementRule = rules.find(rule => String(rule && rule.fileKind || '').trim() === fileKind);
            const relativeDirPattern = placementRule && String(placementRule.relativeDirPattern || '').trim();
            if (relativeDirPattern) {
                candidates.push({ key: `rulePlacementContract.${fileKind}`, template: relativeDirPattern });
            }
        }
        if (candidates.length === 0) {
            return {
                ok: false,
                errorCode: 'DESIGN_TDD_SCAN_PATH_TEMPLATE_MISSING',
                message: `工程导航契约缺少 ${fileKind} 对应路径模板。`
            };
        }
        for (const item of candidates) {
            if (this._targetMatchesTemplate(targetFile, projectPath, item.template)) {
                return {
                    ok: true,
                    pathKey: item.key,
                    template: item.template
                };
            }
        }
        return {
            ok: false,
            errorCode: 'DESIGN_TDD_SKELETON_TARGET_NOT_FROM_SCAN',
            message: `targetFile 未命中 scan 路径模板：${targetFile}`
        };
    }

    _targetMatchesTemplate(targetFile = '', projectPath = '', template = '') {
        const relativeTarget = path.relative(path.resolve(projectPath), path.resolve(targetFile)).replace(/\\/g, '/');
        if (!relativeTarget || relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) {
            return false;
        }
        const normalizedTemplate = String(template || '')
            .replace(/\\/g, '/')
            .replace(/^\.?\//g, '')
            .replace(/\/+$/g, '');
        if (!normalizedTemplate) {
            return false;
        }
        const templatePattern = this._escapeRegexWithPlaceholders(normalizedTemplate);
        return new RegExp(`^${templatePattern}/[^/]+$`, 'u').test(relativeTarget);
    }

    /**
     * 从 targetFile + 匹配的 path 模板提取占位符值。
     *
     * 故事线：LLM 物化时只传 plan 里的 moduleId / targetFile / fileKind，
     * 模板里 `{项目}` `{domain}` `{bizModule}` 这些来自 scan 真值的占位符由 Builder 派生。
     * 这些值都能从 targetFile 路径段对位提取出来（targetFile 必然命中 scan 模板，否则前面
     * `_targetMatchesNavigationContract` 已经 blocked 了）。
     *
     * 修复：Builder 自动从 targetFile 反解出这些路径段占位符，汇总到内部 substitutions。
     * LLM 漏传 `{项目}` `{模块}` 时不再让 unresolved，骨架里残留 `{项目}` `{模块}` 字面占位符
     * 的 bug 直接消失。
     *
     * 关键：模板里的 `{模块}` 在 scan 路径里实际名为 `{bizModule}`，需要双向 alias 映射。
     */
    _extractPlaceholdersFromTargetPath(targetFile, projectPath, template) {
        if (!targetFile || !projectPath || !template) return {};
        const relativeTarget = path.relative(path.resolve(projectPath), path.resolve(targetFile)).replace(/\\/g, '/');
        if (!relativeTarget || relativeTarget.startsWith('..')) return {};

        const normalizedTemplate = String(template || '')
            .replace(/\\/g, '/')
            .replace(/^\.?\//g, '')
            .replace(/\/+$/g, '');
        if (!normalizedTemplate) return {};

        // 解析模板：把 {xxx} 占位符位置记下来，构造命名捕获组 regex
        const placeholderNames = [];
        const parts = normalizedTemplate.split(/(\{[^}]+\})/u);
        const regexParts = parts.map(part => {
            const m = part.match(/^\{([^}]+)\}$/u);
            if (m) {
                placeholderNames.push(m[1]);
                return '([^/]+)';
            }
            return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        });
        // 末尾匹配 /<filename>
        const fullRegex = new RegExp(`^${regexParts.join('')}/[^/]+$`, 'u');
        const match = relativeTarget.match(fullRegex);
        if (!match) return {};

        const out = {};
        for (let i = 0; i < placeholderNames.length; i++) {
            const placeholderName = placeholderNames[i];
            const captured = match[i + 1];
            if (!captured) continue;
            // 把 scan 模板里的 placeholder name 翻译回规则模板里使用的 placeholder name
            //   scan 路径：{项目}/{domain}/{bizModule}/...
            //   规则模板：{项目}/{模块}/...
            // 同义对应：bizModule ↔ 模块；project/项目 等价
            const aliases = this._placeholderAliasesFor(placeholderName);
            for (const alias of aliases) {
                out[`{${alias}}`] = captured;
            }
        }

        // 派生 {项目}：scan 模板里 com/epoint/<xmgxh>/ 这段往往是字面量（不是 placeholder），
        // 但规则模板里包名声明用 com.epoint.{项目}.<domain>.<bizModule> 形式。
        // 提取 com/epoint/ 后面紧跟的字面段作为 {项目} 值。
        // 规则模板用 {项目}（中文），主 substitutions 阶段还会用到 {project}（英文别名）。
        if (!out['{项目}']) {
            const projectMatch = relativeTarget.match(/com\/epoint\/([^/]+)\//);
            if (projectMatch && projectMatch[1]) {
                out['{项目}'] = projectMatch[1];
                out['{project}'] = projectMatch[1];
            }
        }

        return out;
    }

    /**
     * 同一概念在不同上下文的 placeholder 别名。返回的列表里第一个是主名，其它是同义名。
     * scan 模板里通常用 {bizModule} {project}，而规则模板里通常写 {模块} {项目}，
     * Builder 自动两套都填，不让 LLM 选。
     */
    _placeholderAliasesFor(placeholderName) {
        const name = String(placeholderName || '').trim();
        const map = {
            bizModule: ['bizModule', 'module', '模块'],
            module: ['module', 'bizModule', '模块'],
            模块: ['模块', 'module', 'bizModule'],
            项目: ['项目', 'project'],
            project: ['project', '项目'],
            domain: ['domain'],
            EntityName: ['EntityName'],
            FeatureName: ['FeatureName', 'EntityName']
        };
        return map[name] || [name];
    }

    _escapeRegexWithPlaceholders(template = '') {
        const parts = String(template || '').split(/(\{[^}]+\})/u);
        return parts.map(part => {
            if (/^\{[^}]+\}$/u.test(part)) {
                return '[^/]+';
            }
            return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }).join('');
    }

    _readJson(filePath) {
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch (_) {
            return null;
        }
    }

    _isSameOrChild(candidate, parent) {
        const normalizedCandidate = path.resolve(candidate);
        const normalizedParent = path.resolve(parent);
        const rel = path.relative(normalizedParent, normalizedCandidate);
        return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
    }

    _blocked(errorCode, message, extra = {}) {
        return {
            ok: false,
            status: 'blocked',
            actionMode: 'blocker',
            errorCode,
            message,
            ...extra
        };
    }
}

module.exports = DesignTddSkeletonService;
