const fs = require('fs');
const path = require('path');
const { SkillPolicyEnforcer } = require('./skill-policy-loader');
const TechStackGuardService = require('./design-tdd-code-style-guard-service');
const {
    isCommandToolName,
    isRuleExpertReadOnlyAction,
    isHighRiskToolName,
    isReadToolName,
    isSearchToolName,
    isWriteToolName,
    isDirectoryEnumerationToolName,
    isSkillReferenceSearch,
    normalizeToolName
} = require('./skill-tool-policy-shared');

const DESIGN_TDD_CODER_SKILL = 'epoint-design-tdd-coder';
const DESIGN_TDD_SPECIALIST_CODER_SKILLS = [
    'epoint-statistics-coder',
    'epoint-workflow-coder'
];
const DESIGN_TDD_CONSTRUCTION_CODER_SKILLS = [
    DESIGN_TDD_CODER_SKILL,
    ...DESIGN_TDD_SPECIALIST_CODER_SKILLS
];
const DESIGN_TDD_CODER_ORCHESTRATION_TOOLS = Object.freeze([
    'design_tdd_build_plan',
    'design_tdd_skeleton_materialize'
]);
const VIBE_CODING_MODE = 'vibe_coding';
const VIBE_CODING_TASKS_FILE = 'demand-implementation-tasks.md';

function uniqueStrings(values = []) {
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

class SkillRuntimeToolGuardService {
    constructor(options = {}) {
        this.workspaceRoot = options.workspaceRoot || process.cwd();
        this.requirementAnalyzerPreparePasses = new Map();
        this.documentationGrants = new Map();
        this.lastDesignTddCoderProjectPath = '';
        this.lastDesignTddCoderContext = null;
        this.activeSkill = null;
        this.policyEnforcer = options.policyEnforcer || new SkillPolicyEnforcer();
        this.requirementAnalyzerSkillRoot = String(options.requirementAnalyzerSkillRoot || '').trim() ||
            this._resolveBundledSkillRoot('epoint-requirement-analyzer');
        this.requirementDesignSkillRoot = String(options.requirementDesignSkillRoot || '').trim() ||
            this._resolveBundledSkillRoot('epoint-requirement-design');
        this.designTddCoderSkillRoot = String(options.designTddCoderSkillRoot || '').trim() ||
            this._resolveBundledSkillRoot(DESIGN_TDD_CODER_SKILL);
    }

    beforeToolCall(name, args = {}) {
        const projectPath = this._extractToolProjectPath(args);
        const normalizedName = this._normalizeToolName(name);
        this._traceBeforeToolCall(name, args, projectPath);
        if (normalizedName === 'design_prepare_context') {
            const designArgs = this._normalizeToolArgCandidates(args)
                .find(candidate => candidate && Object.prototype.hasOwnProperty.call(candidate, 'phase')) || args;
            const phase = String(designArgs.phase || '').trim().toLowerCase();
            if (!phase || phase === 'entry' || phase === 'prepare') {
                // Design的无副作用prepare是跨压缩/重启恢复入口，任何锁状态都必须可调用。
                return null;
            }
            if (['structure_confirmed', 'details_confirmed', 'page_design_confirmed'].includes(phase)
                && !String(designArgs.stepId || '').trim()) {
                return this._blockedToolResponse('DESIGN_WORKFLOW_STEP_ID_REQUIRED', [
                    'Design写提交缺少currentStepId。先无phase调用design_prepare_context恢复，不得猜测或复用旧stepId。',
                    '[STOP]'
                ]);
            }
        }

        const requirementAnalyzerArtifactGuard = this._guardRequirementAnalyzerDemandArtifactAccess(name, args, projectPath);
        if (requirementAnalyzerArtifactGuard) {
            return requirementAnalyzerArtifactGuard;
        }

        this._ensureDesignTddCoderPolicyContextForHostTool(name, args, projectPath);
        this._ensureRequirementDesignPolicyContextForHostTool(name, args, projectPath);
        this._ensureRequirementAnalyzerPolicyContextForHostTool(name, args, projectPath);

        const designTddProjectBuildCommandGuard = this._guardDesignTddConstructionBuildCommand(name, args, projectPath);
        if (designTddProjectBuildCommandGuard) {
            return designTddProjectBuildCommandGuard;
        }

        const documentationAccess = this._guardDeliveryDocumentationAccess(name, args, projectPath);
        if (documentationAccess && documentationAccess.allowed === true) {
            return null;
        }
        if (documentationAccess && documentationAccess.blocked) {
            return documentationAccess.blocked;
        }

        // === 通用 Skill Policy 物理拦截（v1）===
        // 只对 active skill 生效；Skill 不写 policy.json 时退化为放行。
        // 优先级：在各 skill hardcoded 分支之前。
        const policyHit = this._checkActiveSkillPolicy(name, args, projectPath);
        if (policyHit) {
            return this._blockedToolResponse(policyHit.code, this._buildPolicyBlockedMessages(policyHit));
        }

        const designTddCoderGuard = this._guardDesignTddCoderHostTool(name, args, projectPath);
        if (designTddCoderGuard) {
            return designTddCoderGuard;
        }

        const designDocumentWriteGuard = this._guardDesignDocumentWrite(name, args);
        if (designDocumentWriteGuard) {
            return designDocumentWriteGuard;
        }

        return null;
    }

    /**
     * 通用 Skill Policy 拦截入口。
     * 当前 active skill 有 policy.json 时按其规则物理拦截。
     * 返回 { code, reason } 或 null。
     */
    _checkActiveSkillPolicy(toolName, args = {}, projectPath = '') {
        if (!this.activeSkill || !this.activeSkill.skillRoot) return null;
        // 校验 args.skillName（如果调用方传了）必须与当前 active skill 一致；
        // 否则视为无 policy 上下文（保守不拦），交给后续 hardcoded 分支处理。
        const parameters = args.parameters && typeof args.parameters === 'object' ? args.parameters : {};
        const argsSkillName = this._normalizeSkillName(args.skillName || args.skill || args.role ||
            parameters.skillName || parameters.skill || parameters.role || '');
        if (argsSkillName && argsSkillName !== this.activeSkill.skillName) {
            return null;
        }
        const demandDir = this._resolveDemandDirForPolicy(projectPath);
        return this.policyEnforcer.check(toolName, args, {
            skillRoot: this.activeSkill.skillRoot,
            projectPath,
            demandDir,
            workspaceRoot: this.workspaceRoot
        });
    }

    _ensureRequirementAnalyzerPolicyContextForHostTool(toolName, args = {}, projectPath = '') {
        if (this.activeSkill || !this.requirementAnalyzerSkillRoot) return;
        const normalizedTool = this._normalizeToolName(toolName);
        if (!isHighRiskToolName(normalizedTool)) return;

        const skillName = this._normalizeSkillName(args.skillName || args.skill || args.role ||
            (args.parameters && (args.parameters.skillName || args.parameters.skill || args.parameters.role)) || '');
        if (skillName && skillName !== 'epoint-requirement-analyzer') return;

        const root = this._resolveRequirementAnalyzerHostProjectRoot(args, projectPath);
        if (!root || !this._isRequirementAnalyzerHostDemandStage(root)) return;

        try {
            this.activateSkill('epoint-requirement-analyzer', {
                skillRoot: this.requirementAnalyzerSkillRoot
            });
        } catch (_) {
            // 激活失败时保持原有兜底行为，避免 Runtime Guard 自身打断非需求链路。
        }
    }

    _resolveRequirementAnalyzerHostProjectRoot(args = {}, projectPath = '') {
        const candidates = [];
        const parameters = args.parameters && typeof args.parameters === 'object' ? args.parameters : {};
        const push = value => {
            const text = String(value || '').trim();
            if (text) candidates.push(text);
        };
        push(projectPath);
        push(args.workdir);
        push(args.cwd);
        push(parameters.workdir);
        push(parameters.cwd);
        push(this.workspaceRoot);
        for (const targetPath of this._extractWritePathsForOwnedCheck(args)) {
            push(targetPath);
        }
        for (const targetPath of this._extractReadPathsForOwnedCheck(args)) {
            push(targetPath);
        }

        const seen = new Set();
        for (const candidate of candidates) {
            let current = path.resolve(candidate);
            for (let i = 0; i < 32; i++) {
                const key = this._normalizeTarget(current);
                if (!seen.has(key)) {
                    seen.add(key);
                    if (fs.existsSync(path.join(current, '.ai-workspace', 'project', '.active-demand'))) {
                        return current;
                    }
                }
                const parent = path.dirname(current);
                if (!parent || parent === current) break;
                current = parent;
            }
        }
        return '';
    }

    _isRequirementAnalyzerHostDemandStage(projectPath = '') {
        const root = String(projectPath || '').trim();
        if (!root) return false;
        const projectArtifactsDir = path.join(root, '.ai-workspace', 'project');
        const activeDemandPath = path.join(projectArtifactsDir, '.active-demand');
        if (!fs.existsSync(activeDemandPath)) return false;
        let demandName = '';
        try {
            demandName = String(fs.readFileSync(activeDemandPath, 'utf-8') || '').trim();
        } catch (_) {
            return false;
        }
        if (!this._isValidDemandName(demandName)) return false;
        const demandDir = path.join(projectArtifactsDir, demandName);
        return !fs.existsSync(path.join(demandDir, 'design', 'design-state.json')) &&
            !fs.existsSync(path.join(demandDir, 'code', 'code-state.json'));
    }

    _ensureRequirementDesignPolicyContextForHostTool(toolName, args = {}, projectPath = '') {
        if (this.activeSkill || !this.requirementDesignSkillRoot) return;
        const normalizedTool = this._normalizeToolName(toolName);
        if (!isHighRiskToolName(normalizedTool)) return;

        const skillName = this._normalizeSkillName(args.skillName || args.skill || args.role ||
            (args.parameters && (args.parameters.skillName || args.parameters.skill || args.parameters.role)) || '');
        if (skillName && skillName !== 'epoint-requirement-design') return;

        const root = this._resolveRequirementAnalyzerHostProjectRoot(args, projectPath);
        if (!root || !this._isRequirementDesignHostStage(root)) return;

        try {
            this.activateSkill('epoint-requirement-design', {
                skillRoot: this.requirementDesignSkillRoot
            });
        } catch (_) {
            // 激活失败时保持原有行为，避免 Runtime Guard 自身打断非设计链路。
        }
    }

    _isRequirementDesignHostStage(projectPath = '') {
        const root = String(projectPath || '').trim();
        if (!root) return false;
        const projectArtifactsDir = path.join(root, '.ai-workspace', 'project');
        const activeDemandPath = path.join(projectArtifactsDir, '.active-demand');
        if (!fs.existsSync(activeDemandPath)) return false;
        let demandName = '';
        try {
            demandName = String(fs.readFileSync(activeDemandPath, 'utf-8') || '').trim();
        } catch (_) {
            return false;
        }
        if (!this._isValidDemandName(demandName)) return false;
        const demandDir = path.join(projectArtifactsDir, demandName);
        return fs.existsSync(path.join(demandDir, 'design', 'design-state.json')) &&
            !fs.existsSync(path.join(demandDir, 'code', 'code-state.json'));
    }

    _ensureDesignTddCoderPolicyContextForHostTool(toolName, args = {}, projectPath = '') {
        if (!this.designTddCoderSkillRoot) return;
        const normalizedTool = this._normalizeToolName(toolName);
        if (!isHighRiskToolName(normalizedTool) && normalizedTool !== 'rule_expert') return;

        const parameters = args.parameters && typeof args.parameters === 'object' ? args.parameters : {};
        const skillName = this._normalizeSkillName(args.skillName || args.skill || args.role ||
            parameters.skillName || parameters.skill || parameters.role || '');
        const context = this._resolveDesignTddCoderHostContext(args, projectPath);
        if (!context) return;
        const activeSkillName = this._normalizeSkillName(this.activeSkill && this.activeSkill.skillName || '');
        if (activeSkillName === DESIGN_TDD_CODER_SKILL) {
            this.markDesignTddCoderProject(context.projectPath);
            return;
        }
        if (this.activeSkill && activeSkillName && activeSkillName !== DESIGN_TDD_CODER_SKILL) return;
        if (skillName && skillName !== DESIGN_TDD_CODER_SKILL) return;

        try {
            this.activateSkill(DESIGN_TDD_CODER_SKILL, {
                skillRoot: this.designTddCoderSkillRoot
            });
            this.markDesignTddCoderProject(context.projectPath);
        } catch (_) {
            // 自动激活失败时保持后续拦截逻辑的保守行为。
        }
    }

    _resolveDesignTddCoderHostProjectRoot(args = {}, projectPath = '') {
        const context = this._resolveDesignTddCoderHostContext(args, projectPath);
        return context && context.projectPath || '';
    }

    _resolveDesignTddCoderHostContext(args = {}, projectPath = '') {
        const inferredFromArgs = this._resolveDesignTddCoderProjectRootFromArgs(args);
        if (inferredFromArgs) {
            const directContext = this._buildDesignTddCoderActiveDemandContext(inferredFromArgs);
            if (directContext) return directContext;
        }
        const directRoot = this._resolveRequirementAnalyzerHostProjectRoot(args, projectPath);
        const directContext = this._buildDesignTddCoderActiveDemandContext(directRoot);
        if (directContext) return directContext;

        const lastContext = this.lastDesignTddCoderContext && typeof this.lastDesignTddCoderContext === 'object'
            ? this.lastDesignTddCoderContext
            : null;
        const lastRoot = String(lastContext && lastContext.projectPath || this.lastDesignTddCoderProjectPath || '').trim();
        const activeContext = this._buildDesignTddCoderActiveDemandContext(lastRoot);
        if (!activeContext) return null;
        if (lastContext && String(lastContext.demandName || '').trim()
            && String(lastContext.demandName || '').trim() !== activeContext.demandName) {
            return null;
        }
        return activeContext;
    }

    _resolveDesignTddCoderProjectRootFromArgs(args = {}) {
        const candidates = this._extractReadPathsForOwnedCheck(args)
            .concat(this._extractWritePathsForOwnedCheck(args));
        for (const candidate of candidates) {
            const root = this._extractDesignTddProjectRootFromPath(candidate);
            if (root) return root;
        }
        return '';
    }

    _extractDesignTddProjectRootFromPath(candidate = '') {
        const resolved = path.resolve(String(candidate || '').trim());
        if (!resolved) return '';
        const normalized = resolved.replace(/\\/g, '/').toLowerCase();
        const marker = '/.ai-workspace/project/';
        const markerIndex = normalized.indexOf(marker);
        if (markerIndex < 0) return '';
        const afterMarker = normalized.slice(markerIndex + marker.length);
        const demandName = afterMarker.split('/')[0];
        if (!this._isValidDemandName(demandName)) return '';
        return resolved.slice(0, markerIndex);
    }

    markDesignTddCoderProject(projectPath = '') {
        const root = String(projectPath || '').trim();
        if (!root) return;
        try {
            const resolved = this._guardAgainstPluginRoot(path.resolve(root));
            const context = this._buildDesignTddCoderActiveDemandContext(resolved);
            if (context) {
                this.lastDesignTddCoderProjectPath = resolved;
                this.lastDesignTddCoderContext = context;
            }
        } catch (_) {
            // 最近项目只用于 host 工具缺 projectPath 时的 guard 归属；失败不影响主流程。
        }
    }

    _buildDesignTddCoderActiveDemandContext(projectPath = '') {
        const root = String(projectPath || '').trim();
        if (!root) return null;
        const active = this._readActiveDemandName(root);
        if (!active) return null;
        const demandDir = path.join(path.resolve(root), '.ai-workspace', 'project', active);
        const codeDir = path.join(demandDir, 'code');
        const codeStatePath = path.join(codeDir, 'code-state.json');
        const codeState = this._readJsonIfExists(codeStatePath);
        if (!codeState || codeState.schemaVersion !== 'design-tdd-code-state/v3') return null;
        const isVibeCoding = String(codeState.codingMode || '').trim().toLowerCase() === VIBE_CODING_MODE
            || codeState.phase === VIBE_CODING_MODE;
        return {
            projectPath: path.resolve(root),
            demandName: active,
            demandDir,
            codeDir,
            codeStatePath,
            hasCodeRuntime: true,
            isVibeCoding,
            codingMode: isVibeCoding ? VIBE_CODING_MODE : String(codeState.phase || 'skeleton_materialize')
        };
    }

    _readActiveDemandName(projectPath = '') {
        const root = String(projectPath || '').trim();
        if (!root) return '';
        const activeDemandPath = path.join(path.resolve(root), '.ai-workspace', 'project', '.active-demand');
        if (!fs.existsSync(activeDemandPath)) return '';
        try {
            const demandName = String(fs.readFileSync(activeDemandPath, 'utf-8') || '').trim();
            return this._isValidDemandName(demandName) ? demandName : '';
        } catch (_) {
            return '';
        }
    }

    /**
     * 拼装 policy 命中后的多行阻断文案。
     *
     * AGENTS.md "Skill 物理拦截 / 不写死 skill 名"：本方法只能消费 policyHit 字段
     * （reason / code 等）和 [STOP] 通用尾巴，不允许出现 `skillName === 'xxx'` 分支。
     * 阶段相关的"下一步行动"必须由对应阶段的 policy.json `reason` 自带，或由阶段
     * 内的 MCP 工具（如 design_acknowledge）返回 nextActionCard。
     */
    _buildPolicyBlockedMessages(policyHit = {}) {
        return [policyHit.reason, '[STOP]'];
    }

    _guardDesignTddConstructionBuildCommand(name, args = {}, projectPath = '') {
        const toolName = this._normalizeToolName(name);
        if (!isCommandToolName(toolName)) return null;
        const command = this._extractCommandText(args);
        if (!command || !this._isProjectBuildCommand(command)) return null;
        const context = this._resolveDesignTddCoderHostContext(args, projectPath);
        if (context && context.isVibeCoding) return null;
        if (!this._isDesignTddConstructionContext(args, projectPath, command)) return null;

        return this._blockedToolResponse('DESIGN_TDD_CODER_PROJECT_BUILD_COMMAND_FORBIDDEN', [
            '骨架物化完成前禁止项目级编译、构建、测试或包管理器命令。',
            '先完成 design_tdd_build_plan 与 design_tdd_skeleton_materialize；骨架完成后进入整需求 Vibe Coding，再由编码模型自行运行项目验证。',
            '[STOP]'
        ], {
            actionMode: 'skeleton_materialize_project_build_command_forbidden',
            allowedNextActions: [
                'complete_design_tdd_skeleton_materialize_then_start_vibecoding'
            ],
            forbiddenActions: [
                'run_mvn_compile_in_coder_stage',
                'run_project_build_in_specialist_skill',
                'run_npm_build_or_test_in_design_tdd_construction'
            ]
        });
    }

    _extractCommandText(args = {}) {
        const parameters = args.parameters && typeof args.parameters === 'object' ? args.parameters : {};
        return String(args.command || args.cmd || args.pattern ||
            parameters.command || parameters.cmd || parameters.pattern || '').trim();
    }

    _isProjectBuildCommand(command = '') {
        const text = String(command || '').trim();
        if (!text) return false;
        return /(^|[\s;&|()`])(?:\.\/|\.\\)?mvn(?:\.cmd)?(?:\s+[^;&|]*)?\s+(?:clean\s+)?(?:compile|test|package|install)(?=\s|$|[;&|>])/iu.test(text)
            || /(^|[\s;&|()`])maven(?:\s+[^;&|]*)?\s+(?:clean\s+)?(?:compile|test|package|install)(?=\s|$|[;&|>])/iu.test(text)
            || /(^|[\s;&|()`])(?:\.\/|\.\\)?gradle(?:w|\.bat|\.cmd)?(?:\s+[^;&|]*)?\s+(?:clean\s+)?(?:build|test)(?=\s|$|[;&|>])/iu.test(text)
            || /(^|[\s;&|()`])javac(?:\.exe)?(?=\s|$|[;&|>])/iu.test(text)
            || /(^|[\s;&|()`])npm(?:\.cmd)?\s+(?:install|test)(?=\s|$|[;&|>])/iu.test(text)
            || /(^|[\s;&|()`])npm(?:\.cmd)?\s+run\s+(?:build|compile|test)(?=\s|$|[;&|>])/iu.test(text)
            || /(^|[\s;&|()`])yarn(?:\.cmd)?(?:\s+run)?\s+(?:install|test|build)(?=\s|$|[;&|>])/iu.test(text)
            || /(^|[\s;&|()`])pnpm(?:\.cmd)?\s+(?:install|test|build)(?=\s|$|[;&|>])/iu.test(text)
            || /(^|[\s;&|()`])pnpm(?:\.cmd)?\s+run\s+(?:build|compile|test)(?=\s|$|[;&|>])/iu.test(text);
    }

    _isDesignTddConstructionContext(args = {}, projectPath = '', command = '') {
        const parameters = args.parameters && typeof args.parameters === 'object' ? args.parameters : {};
        const explicitSkill = this._normalizeSkillName(args.skillName || args.skill || args.role ||
            parameters.skillName || parameters.skill || parameters.role || '');
        if (this._isDesignTddConstructionSkill(explicitSkill)) return true;

        const activeSkill = this._normalizeSkillName(this.activeSkill && this.activeSkill.skillName || '');
        if (this._isDesignTddConstructionSkill(activeSkill)) return true;

        const context = this._resolveDesignTddCoderHostContext(args, projectPath);
        if (context) return true;

        for (const candidate of this._extractCommandWorkingDirs(command)) {
            if (this._buildDesignTddCoderActiveDemandContext(candidate)) return true;
            const root = this._resolveRequirementAnalyzerHostProjectRoot({}, candidate);
            if (root && this._buildDesignTddCoderActiveDemandContext(root)) return true;
        }
        return false;
    }

    _isDesignTddConstructionSkill(skillName = '') {
        const normalized = this._normalizeSkillName(skillName);
        return DESIGN_TDD_CONSTRUCTION_CODER_SKILLS.includes(normalized);
    }

    _extractCommandWorkingDirs(command = '') {
        const text = String(command || '');
        if (!text) return [];
        const dirs = [];
        const push = value => {
            const cleaned = String(value || '').trim();
            if (cleaned) dirs.push(cleaned);
        };

        const quotedCd = /(?:^|[\s;&|])(?:cd|chdir|set-location|sl)\s+(?:\/d\s+)?["']([^"']+)["']/giu;
        let match = null;
        while ((match = quotedCd.exec(text)) !== null) {
            push(match[1]);
        }

        const bareCd = /(?:^|[\s;&|])(?:cd|chdir|set-location|sl)\s+(?:\/d\s+)?([^\s;&|<>]+(?:\s+[^\s;&|<>]+)*?)(?=\s*(?:&&|\|\||[;&|<>]|$))/giu;
        while ((match = bareCd.exec(text)) !== null) {
            push(match[1]);
        }
        return Array.from(new Set(dirs));
    }

    _buildDesignTddCoderSkeletonIncompleteResponse(toolName = '') {
        return this._blockedToolResponse('DESIGN_TDD_CODER_SKELETON_INCOMPLETE', [
            `骨架物化尚未完成，暂不能调用 ${toolName || '编码工具'} 进入业务实现。`,
            '先完成 design_tdd_skeleton_materialize；返回骨架完成卡后，再启动整需求 Vibe Coding。',
            '[STOP]'
        ], {
            actionMode: 'complete_skeleton_before_vibecoding',
            allowedNextActions: ['complete_design_tdd_skeleton_materialize_then_start_vibecoding'],
            forbiddenActions: ['start_partial_story_coding', 'call_retired_coder_orchestration']
        });
    }

    _guardDesignTddCoderHostTool(name, args = {}, projectPath = '') {
        const activeSkillName = this._normalizeSkillName(this.activeSkill && this.activeSkill.skillName || '');
        const toolName = this._normalizeToolName(name);
        const isHostWrite = ['write_to_file', 'write_file', 'create_file', 'replace_in_file', 'apply_patch'].includes(toolName);
        // 未知 MCP 名称由服务端分发器报错，不把它解释为宿主编码操作。
        if (!isHighRiskToolName(toolName) && !this._isDesignTddCoderSearchTool(toolName) && !isHostWrite
            && !DESIGN_TDD_CODER_ORCHESTRATION_TOOLS.includes(toolName) && toolName !== 'rule_expert') return null;
        const recoveredContext = this._resolveDesignTddCoderHostContext(args, projectPath);
        if (activeSkillName !== DESIGN_TDD_CODER_SKILL && !recoveredContext) return null;
        const effectiveProjectPath = recoveredContext && recoveredContext.projectPath ||
            this._resolveDesignTddCoderHostProjectRoot(args, projectPath) ||
            projectPath;
        const runtimeState = this._loadDesignTddCoderCurrentWorkState(effectiveProjectPath);
        if (runtimeState.codeState?.phase === 'skeleton_materialize'
            && DESIGN_TDD_CODER_ORCHESTRATION_TOOLS.includes(toolName)) return null;
        if ((recoveredContext && recoveredContext.isVibeCoding) || runtimeState.isVibeCoding) {
            return this._guardVibeCodingHostTool(toolName, args, effectiveProjectPath, runtimeState);
        }
        if (['design_tdd_build_plan', 'design_tdd_skeleton_materialize'].includes(toolName)) {
            return null;
        }
        return this._buildDesignTddCoderSkeletonIncompleteResponse(toolName || name);
    }

    _guardVibeCodingHostTool(toolName = '', args = {}, projectPath = '', runtimeState = {}) {
        if (DESIGN_TDD_CODER_ORCHESTRATION_TOOLS.includes(toolName)) {
            if (toolName === 'design_tdd_skeleton_materialize'
                && this._isSafeDesignTddSkeletonReplay(projectPath, runtimeState)) {
                // 客户端超时、断线或重复提交可能让已完成骨架的响应丢失。
                // 只读重放不会推进 Story 或修改业务代码，允许它回到专用入口取回完成凭证；
                // 人读计划/进度存在不改变只读重放的安全性。
                return null;
            }
            return this._blockedToolResponse('DESIGN_TDD_CODER_VIBE_MCP_ORCHESTRATION_FORBIDDEN', [
                `骨架完成后已进入纯提示词 Vibe Coding，禁止调用 ${toolName}。`,
                '直接读取当前需求目录的 Story、骨架、规则和公司实践，按业务连续性自行规划、修改和验证。',
                '本次调用未执行。编码阶段不通过 Epoint MCP 推进状态；按已有计划和进度继续本地实现，不重建计划、不要求用户确认。'
            ], {
                repairRequired: true,
                actionMode: 'direct_vibecoding',
                allowedNextActions: ['read_complete_demand_and_write_implementation_plan'],
                forbiddenActions: ['call_coder_orchestration_mcp', 'modify_builder_owned_truth_files']
            });
        }
        if (toolName === 'rule_expert') {
            const parameters = args.parameters && typeof args.parameters === 'object' ? args.parameters : {};
            const action = String(args.action || parameters.action || '').trim().toLowerCase();
            if (isRuleExpertReadOnlyAction(action)) return null;
            return this._blockedToolResponse('DESIGN_TDD_CODER_VIBE_RULE_ACTION_FORBIDDEN', [
                `Vibe Coding 只允许通过 rule_expert 读取或搜索规则，当前 action=${action || 'missing'} 不允许。`,
                '允许：rule_expert(action=read) 获取规则正文，或 rule_expert(action=search) 搜索规则目录；这两个动作只读，不修改编码运行态。',
                '本次调用未执行。规则名称从当前 intake 的 readCatalog 取得；同轮改用 action=read 或 action=search 后继续编码，不要求用户确认。'
            ], {
                repairRequired: true,
                actionMode: 'direct_vibecoding_rule_read_only',
                allowedNextActions: ['rule_expert_read', 'rule_expert_search'],
                forbiddenActions: ['rule_expert_analyze', 'rule_expert_execute']
            });
        }
        if (this._isDesignTddCoderSearchTool(toolName) || isCommandToolName(toolName)) return null;

        if (isReadToolName(toolName)) {
            // 只读查证可沿当前工程调用链展开；写入授权不用于限制源码读取。
            return null;
        }

        const isHostWriteTool = isWriteToolName(toolName) ||
            ['fs_write', 'str_replace', 'write_to_file'].includes(toolName);
        if (!isHostWriteTool) return null;

        const writeTargets = this._extractWritePathsForOwnedCheck(args)
            .map(target => this._resolveTargetInsideProject(target, projectPath))
            .filter(Boolean);
        if (writeTargets.length === 0) {
            return this._blockedToolResponse('DESIGN_TDD_CODER_WRITE_TARGET_REQUIRED', [
                `本次写入未执行。${toolName || '写入工具'} 缺少明确文件路径；按当前目标补齐项目内路径，同轮重试，原授权范围不变。`
            ], {
                repairRequired: true,
                actionMode: 'repair_current_coding_patch',
                allowedNextActions: ['correct_patch_and_retry']
            });
        }

        const outsideProject = writeTargets.find(target => !this._isSameOrChild(target, projectPath));
        if (outsideProject) {
            return this._blockedToolResponse('DESIGN_TDD_CODER_WRITE_OUTSIDE_PROJECT', [
                `写入目标不在当前项目内：${outsideProject}`,
                '[STOP]'
            ]);
        }

        const implementationTasksPath = path.join(this._resolveDesignTddCodeDir(projectPath) || '', VIBE_CODING_TASKS_FILE);
        const isImplementationMemoryTarget = target => this._sameResolvedPath(target, implementationTasksPath);
        const nonPlanDemandTarget = writeTargets.find(target =>
            this._isDesignTddCoderDemandStageReadTarget(target, projectPath)
            && !isImplementationMemoryTarget(target));
        if (nonPlanDemandTarget) {
            return this._blockedToolResponse('DESIGN_TDD_CODER_MANAGED_CODE_ARTIFACT_WRITE_FORBIDDEN', [
                `纯提示词 Vibe Coding 只能写实施任务清单 ${implementationTasksPath}，不能直接修改需求目录其它产物：${nonPlanDemandTarget}`,
                'design-tdd-plan、business-facts、规则、状态、凭证和其它 Builder-owned 文件保持只读。',
                '[STOP]'
            ]);
        }

        const forbiddenTarget = writeTargets.find(target => this._isDesignTddCoderForbiddenWritePath(target));
        if (forbiddenTarget) {
            return this._blockedToolResponse('DESIGN_TDD_CODER_PLATFORM_WRITE_FORBIDDEN', [
                `禁止修改规则库、平台目录或平台配置：${forbiddenTarget}`,
                '[STOP]'
            ]);
        }

        const sourceTargets = writeTargets.filter(target =>
            this._isDesignTddProjectSourcePath(target, projectPath)
            || this._isDesignTddProjectTestPath(target, projectPath));
        const outOfDemandSource = sourceTargets.find(target => !this._isDesignTddCoderVibeSourcePath(target, projectPath));
        if (outOfDemandSource) {
            return this._blockedToolResponse('DESIGN_TDD_CODER_VIBE_WRITE_SCOPE_VIOLATION', [
                `源码写入目标不在当前需求的业务源码范围内：${outOfDemandSource}`,
                'Vibe Coding 可以自由选择连续 Story 的承载文件，但仍只能在骨架和需求资料指向的业务源码范围内修改或新增。',
                '[STOP]'
            ], {
                actionMode: 'direct_vibecoding_scope_violation',
                allowedNextActions: ['read_demand_skeleton_and_choose_in_scope_source']
            });
        }
        if (writeTargets.some(target => !sourceTargets.includes(target) && !isImplementationMemoryTarget(target))) {
            return this._blockedToolResponse('DESIGN_TDD_CODER_VIBE_WRITE_SCOPE_VIOLATION', [
                '纯提示词 Vibe Coding 只能写实施任务清单或当前需求业务源码及对应测试。',
                `允许的过程文件：${implementationTasksPath}`,
                '[STOP]'
            ]);
        }

        const prewriteStyleGuard = this._guardDesignTddCoderPrewriteStyle({
            sourceTargets,
            args,
            projectPath
        });
        if (prewriteStyleGuard) return prewriteStyleGuard;
        return null;
    }

    _isSafeDesignTddSkeletonReplay(projectPath = '', runtimeState = {}) {
        if (!runtimeState || runtimeState.isVibeCoding !== true) return false;
        const codeState = runtimeState.codeState && typeof runtimeState.codeState === 'object'
            ? runtimeState.codeState
            : {};
        const skeleton = codeState.skeleton && typeof codeState.skeleton === 'object'
            ? codeState.skeleton
            : {};
        const plannedCount = Number(skeleton.plannedCount);
        const materializedCount = Number(skeleton.materializedCount);
        const pendingCount = Number(skeleton.pendingCount);
        if (!Number.isInteger(plannedCount) || plannedCount < 0
            || !Number.isInteger(materializedCount) || materializedCount < 0
            || !Number.isInteger(pendingCount) || pendingCount !== 0
            || materializedCount !== plannedCount) {
            return false;
        }

        const codeDir = String(runtimeState.codeDir || '').trim();
        if (!codeDir) return false;

        // projectPath 仅用于保持入口语义明确；状态目录必须仍归属于当前项目，
        // 避免无 projectPath 的历史上下文把别的需求误判成可重放。
        const resolvedProject = String(projectPath || '').trim();
        if (!resolvedProject || !this._isSameOrChild(codeDir, resolvedProject)) return false;
        return true;
    }

    _isDesignTddCoderSearchTool(toolName = '') {
        return isSearchToolName(toolName) || isDirectoryEnumerationToolName(toolName) || [
            'codegraph_search',
            'codegraph_context'
        ].includes(this._normalizeToolName(toolName));
    }

    _loadDesignTddCoderVibeCodingScope(projectPath = '') {
        const codeDir = this._resolveDesignTddCodeDir(projectPath);
        const demandDir = codeDir ? path.dirname(codeDir) : '';
        const sourcePaths = [];
        const addSourcePath = value => {
            const text = String(value || '').trim();
            if (!text) return;
            const resolved = this._resolveTargetInsideProject(text, projectPath);
            if (resolved && this._isDesignTddProjectSourcePath(resolved, projectPath)) sourcePaths.push(resolved);
        };
        const addPlanFiles = plan => {
            const modules = Array.isArray(plan && plan.modulesOwnerFiles) ? plan.modulesOwnerFiles : [];
            modules.forEach(module => (Array.isArray(module && module.ownerFiles) ? module.ownerFiles : [])
                .forEach(file => addSourcePath(file && (file.resolvedPath || file.filePath || file.path))));
            const storyPackages = Array.isArray(plan && plan.storyWorkPackages) ? plan.storyWorkPackages : [];
            storyPackages.forEach(story => (Array.isArray(story && story.files) ? story.files : [])
                .forEach(file => addSourcePath(file && (file.resolvedPath || file.filePath || file.path))));
            (Array.isArray(plan && plan.filePlan) ? plan.filePlan : []).forEach(file =>
                addSourcePath(file && (file.resolvedPath || file.filePath || file.path)));
        };
        const addPackageFiles = pack => {
            (Array.isArray(pack && pack.candidateFiles) ? pack.candidateFiles : []).forEach(file =>
                addSourcePath(file && (file.resolvedPath || file.filePath || file.path)));
        };

        addPlanFiles(this._readJsonIfExists(codeDir && path.join(codeDir, 'design-tdd-plan.json')));
        addPackageFiles(this._readJsonIfExists(codeDir && path.join(codeDir, 'requirement-work-package.json')));
        addPackageFiles(this._readJsonIfExists(codeDir && path.join(codeDir, 'work-slices', 'files-fields.json')));

        const sourceRoots = [];
        const addRoot = root => {
            const resolved = this._resolveTargetInsideProject(root, projectPath);
            if (!resolved || !this._isDesignTddProjectSourcePath(resolved, projectPath)) return;
            sourceRoots.push(resolved);
        };
        const addSourceRootsForPath = sourcePath => {
            const normalized = String(sourcePath || '').replace(/\\/g, '/');
            const javaMarker = '/src/main/java/';
            const webMarker = '/src/main/webapp/';
            const javaIndex = normalized.toLowerCase().indexOf(javaMarker);
            if (javaIndex >= 0) {
                const base = normalized.slice(0, javaIndex + javaMarker.length);
                const relative = normalized.slice(javaIndex + javaMarker.length).split('/').filter(Boolean);
                if (relative.length >= 3) addRoot(path.join(base, ...relative.slice(0, 3)));
            }
            const webIndex = normalized.toLowerCase().indexOf(webMarker);
            if (webIndex >= 0) {
                const base = normalized.slice(0, webIndex + webMarker.length);
                const relative = normalized.slice(webIndex + webMarker.length).split('/').filter(Boolean);
                if (relative.length >= 1) addRoot(path.join(base, relative[0]));
            }
            addRoot(path.dirname(sourcePath));
        };
        sourcePaths.forEach(addSourceRootsForPath);
        const testRoots = [];
        sourceRoots.forEach(root => {
            const normalized = String(root).replace(/\\/g, '/');
            const mainSource = /\/src\/main\/(java|resources)(?=\/|$)/u;
            const match = normalized.match(mainSource);
            if (!match) return;
            const testKinds = match[1] === 'java' ? ['java', 'resources'] : ['resources'];
            testKinds.forEach(kind => testRoots.push(normalized.replace(mainSource, `/src/test/${kind}`)));
        });
        return {
            demandDir,
            sourceFiles: new Set(sourcePaths.map(item => this._normalizeTarget(item))),
            sourceRoots: this._collapseVibeSourceRoots(sourceRoots),
            testRoots: this._collapseVibeSourceRoots(testRoots)
        };
    }

    _collapseVibeSourceRoots(roots = []) {
        const normalized = uniqueStrings(roots)
            .map(root => path.resolve(root))
            .sort((left, right) => left.length - right.length);
        const collapsed = [];
        normalized.forEach(root => {
            if (!collapsed.some(parent => this._isSameOrChild(root, parent))) collapsed.push(root);
        });
        return collapsed;
    }

    _isDesignTddCoderVibeSourcePath(target = '', projectPath = '') {
        if (!this._isDesignTddProjectSourcePath(target, projectPath)
            && !this._isDesignTddProjectTestPath(target, projectPath)) return false;
        const scope = this._loadDesignTddCoderVibeCodingScope(projectPath);
        const normalizedTarget = this._normalizeTarget(target);
        return scope.sourceFiles.has(normalizedTarget)
            || scope.sourceRoots.concat(scope.testRoots).some(root => this._isSameOrChild(target, root));
    }

    _isDesignTddProjectTestPath(target = '', projectPath = '') {
        return this._isSameOrChild(target, projectPath)
            && /\/src\/test\/(?:java|resources)\//u.test(String(target).replace(/\\/g, '/').toLowerCase());
    }

    _isDesignTddCoderForbiddenWritePath(target = '') {
        const normalized = String(target || '').replace(/\\/g, '/').toLowerCase();
        return normalized.includes('/projectrules/')
            || normalized.includes('/.project_repo/')
            || normalized.includes('/.knowledge_repo/')
            || normalized.includes('/gxhrules/')
            || /\/webapp\/(?:frame|rest|web-inf|meta-inf|resources)(?:\/|$)/u.test(normalized)
            || /\/src\/main\/resources\/spring(?:\/|$)/u.test(normalized);
    }

    _guardDesignTddCoderPrewriteStyle({ sourceTargets = [], args = {}, projectPath = '' } = {}) {
        const snippets = this._extractDesignTddCoderProposedWriteTexts(args);
        if (snippets.length === 0) return null;
        const guard = new TechStackGuardService();
        const violations = [];
        for (const target of (Array.isArray(sourceTargets) ? sourceTargets : [])) {
            const ext = path.extname(String(target || '')).toLowerCase();
            if (!['.java', '.html', '.htm'].includes(ext)) continue;
            const fileKind = this._inferDesignTddFileKindForPath(target);
            const scanResult = guard.scan(snippets.join('\n'), ext, {
                skipComments: true,
                filePath: target,
                fileKind,
                onlyLines: snippets
            });
            (Array.isArray(scanResult.violations) ? scanResult.violations : []).forEach(item => {
                violations.push({
                    file: target,
                    fileKind,
                    ...item
                });
            });
        }
        if (violations.length === 0) return null;
        return this._blockedToolResponse('DESIGN_TDD_CODER_PREWRITE_CODE_STYLE_VIOLATION', [
            `本次patch未执行：拟写入内容违反公司代码规范（${violations.length} 处）。`,
            JSON.stringify(violations.slice(0, 8)),
            '同轮按规则和公司实践修正当前patch后重新写入，不要求用户确认，不退回设计或重启编码。'
        ], {
            actionMode: 'repair_current_coding_patch',
            allowedNextActions: ['correct_patch_and_retry']
        });
    }

    _loadDesignTddCoderCurrentWorkState(projectPath = '') {
        const codeDir = this._resolveDesignTddCodeDir(projectPath);
        const statePath = codeDir ? path.join(codeDir, 'code-state.json') : '';
        const codeState = this._readJsonIfExists(statePath);
        if (!codeState || codeState.schemaVersion !== 'design-tdd-code-state/v3') {
            return {
                hasCodeRuntime: false,
                isVibeCoding: false,
                codeDir,
                codeState
            };
        }
        const isVibeCoding = String(codeState.codingMode || '').trim().toLowerCase() === VIBE_CODING_MODE
            || String(codeState.phase || '').trim().toLowerCase() === VIBE_CODING_MODE;
        return {
            hasCodeRuntime: true,
            isVibeCoding,
            codeDir,
            codeState
        };
    }

    _extractDesignTddCoderProposedWriteTexts(args = {}) {
        const out = [];
        const contentKeys = new Set([
            'newString',
            'new_string',
            'replacement',
            'newText',
            'new_text',
            'content',
            'text',
            'patch',
            'diff',
            'value'
        ].map(key => key.toLowerCase()));
        const visit = value => {
            if (value === null || value === undefined) return;
            if (typeof value === 'string') {
                return;
            }
            if (Array.isArray(value)) {
                value.forEach(item => visit(item));
                return;
            }
            if (typeof value !== 'object') return;
            Object.keys(value).forEach(key => {
                const next = value[key];
                if (contentKeys.has(String(key).toLowerCase()) && typeof next === 'string' && next.trim()) {
                    out.push(next);
                    return;
                }
                visit(next);
            });
        };
        visit(args);
        return uniqueStrings(out).slice(0, 40);
    }

    _inferDesignTddFileKindForPath(filePath = '') {
        const normalized = String(filePath || '').replace(/\\/g, '/').toLowerCase();
        const fileName = path.basename(normalized);
        if (fileName.endsWith('.html') || fileName.endsWith('.htm')) return 'HtmlPage';
        if (!fileName.endsWith('.java')) return '';
        if (/\/rest\//u.test(normalized) || /restcontroller\.java$/u.test(fileName)) return 'Rest';
        if (/\/job\//u.test(normalized) || /job\.java$/u.test(fileName)) return 'Job';
        if (/\/action\//u.test(normalized) || /action\.java$/u.test(fileName)) return 'Action';
        if (/serviceimpl\.java$/u.test(fileName)) return 'ServiceImpl';
        if (/^i.+service\.java$/iu.test(path.basename(String(filePath || '')))) return 'ServiceApi';
        if (/service\.java$/u.test(fileName)) return 'ServiceInternal';
        if (/\/entity\//u.test(normalized)) return 'Entity';
        return '';
    }

    _traceBeforeToolCall(name, args = {}, projectPath = '') {
        if (String(process.env.EPOINT_SKILL_GUARD_TRACE || '').trim() !== '1') return;
        try {
            const parameters = args.parameters && typeof args.parameters === 'object' ? args.parameters : {};
            const payload = {
                toolName: String(name || ''),
                normalizedToolName: this._normalizeToolName(name),
                projectPath: String(projectPath || ''),
                activeSkill: this.activeSkill ? {
                    skillName: this.activeSkill.skillName || '',
                    hasSkillRoot: Boolean(this.activeSkill.skillRoot)
                } : null,
                argsSkillName: String(args.skillName || args.skill || args.role ||
                    parameters.skillName || parameters.skill || parameters.role || ''),
                targetPath: String(args.path || args.file || args.filePath || args.targetFile ||
                    parameters.path || parameters.file || parameters.filePath || parameters.targetFile || '')
            };
            console.error(`[EPOINT_SKILL_GUARD_TRACE] beforeToolCall ${JSON.stringify(payload)}`);
        } catch (_) {
            // tracing must never affect runtime guard behavior
        }
    }

    _resolveTargetInsideProject(rawTarget = '', projectPath = '') {
        const text = String(rawTarget || '').trim();
        if (!text) return '';
        try {
            return path.isAbsolute(text)
                ? path.resolve(text)
                : path.resolve(projectPath || this.workspaceRoot || process.cwd(), text);
        } catch (_) {
            return '';
        }
    }

    _isDesignTddProjectSourcePath(target = '', projectPath = '') {
        if (!target || !projectPath) return false;
        const resolvedTarget = path.resolve(target);
        const resolvedProject = path.resolve(projectPath);
        if (!this._isSameOrChild(resolvedTarget, resolvedProject)) return false;
        const normalized = resolvedTarget.replace(/\\/g, '/').toLowerCase();
        if (normalized.includes('/.ai-workspace/')) return false;
        return /\/src\/main\/(java|webapp|resources)\//u.test(normalized) ||
            /\/webapp\//u.test(normalized);
    }

    _resolveDesignTddCodeDir(projectPath = '') {
        const root = String(projectPath || '').trim();
        if (!root) return '';
        const anchorPath = path.join(root, '.ai-workspace', 'project', '.active-demand');
        if (!fs.existsSync(anchorPath)) return '';
        try {
            const demandName = String(fs.readFileSync(anchorPath, 'utf-8') || '').trim();
            if (!demandName) return '';
            return path.join(root, '.ai-workspace', 'project', demandName, 'code');
        } catch (_) {
            return '';
        }
    }

    _readJsonIfExists(filePath = '') {
        try {
            if (!filePath || !fs.existsSync(filePath)) return null;
            return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch (_) {
            return null;
        }
    }

    _isDesignTddCoderManagedCodeArtifact(targetPath = '', projectPath = '') {
        const codeDir = this._resolveDesignTddCodeDir(projectPath);
        if (!codeDir || !targetPath) return false;
        const resolvedTarget = path.resolve(targetPath);
        const resolvedCodeDir = path.resolve(codeDir);
        if (!this._isSameOrChild(resolvedTarget, resolvedCodeDir)) return false;
        const baseName = path.basename(resolvedTarget).toLowerCase();
        return new Set([
            'code-state.json',
            'business-facts.json',
            'relevant-rules.json'
        ]).has(baseName);
    }

    _isDesignTddCoderManagedReadArtifact(targetPath = '', projectPath = '') {
        const codeDir = this._resolveDesignTddCodeDir(projectPath);
        if (!codeDir || !targetPath) return false;
        const resolvedTarget = path.resolve(targetPath);
        const resolvedCodeDir = path.resolve(codeDir);
        if (!this._isSameOrChild(resolvedTarget, resolvedCodeDir)) return false;
        const baseName = path.basename(resolvedTarget).toLowerCase();
        return new Set([
            'business-facts.json',
            'requirement-work-draft.json',
            'requirement-work-package.json',
            'design-tdd-plan.json',
            'design-tdd-plan.md',
            'relevant-rules.json',
            'code-state.json',
            'skeleton-compile-receipt.json'
        ]).has(baseName);
    }

    _isDesignTddCoderDemandStageReadTarget(targetPath = '', projectPath = '') {
        if (!targetPath || !projectPath) return false;
        const resolvedTarget = path.resolve(targetPath);
        const resolvedProject = path.resolve(projectPath);
        if (!this._isSameOrChild(resolvedTarget, resolvedProject)) return false;
        const normalized = resolvedTarget.replace(/\\/g, '/').toLowerCase();
        return /\/\.ai-workspace\/project\/[^/]+\/(?:code|design|demand)\//u.test(normalized);
    }

    /**
     * 解析 .active-demand 指针得到当前 demandDir。
     * 失败返回空串；policy 中如果没有用 <demandDir> 占位符，就不影响判断。
     */
    _resolveDemandDirForPolicy(projectPath) {
        const root = String(projectPath || '').trim();
        if (!root) return '';
        const anchorPath = path.join(root, '.ai-workspace', 'project', '.active-demand');
        if (!fs.existsSync(anchorPath)) return '';
        try {
            const demandName = String(fs.readFileSync(anchorPath, 'utf-8') || '').trim();
            if (!demandName) return '';
            return path.join(root, '.ai-workspace', 'project', demandName);
        } catch (_) {
            return '';
        }
    }

    activateSkill(skillName = '', options = {}) {
        const normalizedSkill = this._normalizeSkillName(skillName || options.skillName || '');
        const token = String(options.activeSkillToken || options.token || '').trim() ||
            `skill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        const skillRoot = String(options.skillRoot || '').trim();
        const referencesRoot = String(options.referencesRoot || (skillRoot ? path.join(skillRoot, 'references') : '')).trim();
        const referenceFiles = this._buildReferenceFiles(referencesRoot, options.referenceFiles);
        this.activeSkill = {
            skillName: normalizedSkill,
            token,
            skillRoot,
            referencesRoot,
            referenceFiles,
            platform: options.platform || this._detectPlatform(),
            activatedAt: new Date().toISOString()
        };
        return this.getSkillBootstrapContract(normalizedSkill);
    }

    deactivateSkill(token = '') {
        const expected = String(token || '').trim();
        if (!this.activeSkill) {
            return true;
        }
        if (expected && expected !== this.activeSkill.token) {
            return false;
        }
        this.activeSkill = null;
        return true;
    }

    buildRuntimeReferenceReadContext(name, args = {}) {
        return null;
    }

    getSkillBootstrapContract(skillName = '') {
        const normalizedSkill = this._normalizeSkillName(skillName || (this.activeSkill && this.activeSkill.skillName) || '');
        const active = this.activeSkill && this.activeSkill.skillName === normalizedSkill
            ? this.activeSkill
            : null;
        if (!active || !active.skillRoot || !active.referencesRoot || Object.keys(active.referenceFiles || {}).length === 0 || !active.token) {
            return {
                ok: false,
                code: 'SKILL_BOOTSTRAP_MISSING',
                message: 'skillRoot/referenceFiles/activeSkillToken 未由 host 注入，禁止搜索 skill 文件。'
            };
        }
        return {
            ok: true,
            skillRoot: active.skillRoot,
            referencesRoot: active.referencesRoot,
            referenceFiles: { ...active.referenceFiles },
            platform: active.platform,
            activeSkillToken: active.token
        };
    }

    /**
     * v1.3 Phase 13：识别 shell 命令是否包含写文件操作（覆盖 PowerShell / cmd / bash）。
     */
    _commandWritesFile(command = '') {
        const text = String(command || '');
        if (!text) return false;
        // PowerShell：Set-Content / Out-File / Add-Content / New-Item -ItemType File / Tee-Object
        // cmd：echo > / type >
        // bash：> / >> / cat > / printf > / tee
        return /\b(Set-Content|Out-File|Add-Content|New-Item\s+-ItemType\s+File|Tee-Object|tee)\b/iu.test(text)
            || /(^|\s|;|\||&)(echo|printf|type|cat)\s+[^|]*?\s*>>?/iu.test(text)
            || /[^>]>{1,2}\s*['"]?[^\s'"|&;]+\.(json|md|txt|js|java|html|jsp|sql|xml|yaml|yml)/iu.test(text);
    }

    markRequirementAnalyzerPrepared(projectPath = '', fixedPaths = {}) {
        const projectKey = this._projectKey(projectPath);
        if (!projectKey) {
            return;
        }

        const preparedPaths = fixedPaths && Object.keys(fixedPaths).length > 0
            ? { ok: true, fixedPaths }
            : this._resolveRequirementAnalyzerCanonicalPaths(projectPath);
        if (!preparedPaths.ok) {
            return;
        }

        this.requirementAnalyzerPreparePasses.set(projectKey, {
            preparedAt: new Date().toISOString(),
            fixedPathKey: this._requirementAnalyzerFixedPathKey(preparedPaths.fixedPaths),
            fixedPaths: { ...preparedPaths.fixedPaths }
        });
    }

    _requirementAnalyzerFixedPathKey(fixedPaths = {}) {
        return [
            fixedPaths.activeDemandPath,
            fixedPaths.demandAnalysisPath,
            fixedPaths.analysisStatePath,
            fixedPaths.ruleRecallRawPath,
            fixedPaths.rulePoolPath,
            fixedPaths.finalizeReceiptPath
        ].map(item => path.resolve(String(item || '').trim()).toLowerCase()).join('|');
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

    _extractWritePathsForOwnedCheck(args = {}) {
        // 写工具入参语义比较散：write/Write 用 filePath/path/target；edit_file 用 path；
        // edit_file_search_replace 用 filePath；某些桥用 plannedAction.{path,filePath,target}。
        // 这里集中归一，避免漏拦。
        const candidates = [];
        const push = value => {
            if (Array.isArray(value)) {
                value.forEach(item => push(item));
                return;
            }
            const text = String(value || '').trim();
            if (text) {
                candidates.push(text);
            }
        };
        push(args.filePath);
        push(args.file_path);
        push(args.path);
        push(args.paths);
        push(args.pathsRef);
        push(args.paths_ref);
        push(args.files);
        push(args.uris);
        push(args.uri);
        push(args.url);
        push(args.targetFile);
        push(args.target_file);
        push(args.target);
        push(args.targetPath);
        push(args.target_path);
        push(args.outputPath);
        push(args.output_path);
        push(args.outputDir);
        push(args.output_dir);
        push(args.file);
        push(args.filePaths);
        push(args.file_paths);
        push(args.filePattern);
        push(args.file_pattern);
        push(args.folderPath);
        push(args.folder_path);
        push(args.directoryPath);
        push(args.directory_path);
        push(args.dirPath);
        push(args.dir_path);
        push(args.rootPath);
        push(args.root_path);
        push(args.TargetFile);
        push(args.FilePath);
        push(args.Path);
        const parameters = args.parameters && typeof args.parameters === 'object' ? args.parameters : {};
        push(parameters.filePath);
        push(parameters.file_path);
        push(parameters.path);
        push(parameters.paths);
        push(parameters.pathsRef);
        push(parameters.paths_ref);
        push(parameters.files);
        push(parameters.uris);
        push(parameters.uri);
        push(parameters.url);
        push(parameters.targetFile);
        push(parameters.target_file);
        push(parameters.target);
        push(parameters.targetPath);
        push(parameters.target_path);
        push(parameters.outputPath);
        push(parameters.output_path);
        push(parameters.outputDir);
        push(parameters.output_dir);
        push(parameters.file);
        push(parameters.filePaths);
        push(parameters.file_paths);
        push(parameters.filePattern);
        push(parameters.file_pattern);
        push(parameters.folderPath);
        push(parameters.folder_path);
        push(parameters.directoryPath);
        push(parameters.directory_path);
        push(parameters.dirPath);
        push(parameters.dir_path);
        push(parameters.rootPath);
        push(parameters.root_path);
        const planned = args.plannedAction && typeof args.plannedAction === 'object' ? args.plannedAction : {};
        push(planned.filePath);
        push(planned.file_path);
        push(planned.path);
        push(planned.paths);
        push(planned.files);
        push(planned.uris);
        push(planned.target);
        push(planned.targetFile);
        push(planned.target_file);
        push(planned.targetPath);
        push(planned.target_path);
        push(planned.outputPath);
        push(planned.output_path);
        push(planned.outputDir);
        push(planned.output_dir);
        return candidates;
    }

    _extractReadPathsForOwnedCheck(args = {}) {
        return this._extractWritePathsForOwnedCheck(args);
    }

    _extractSearchRootsForOwnedCheck(args = {}) {
        const roots = [];
        const patterns = [];
        const push = (target, value) => {
            if (Array.isArray(value)) {
                value.forEach(item => push(target, item));
                return;
            }
            const text = String(value || '').trim();
            if (text) {
                target.push(text);
            }
        };
        const collect = source => {
            if (!source || typeof source !== 'object') {
                return;
            }
            push(roots, source.path);
            push(roots, source.directory);
            push(roots, source.root);
            push(roots, source.cwd);
            push(roots, source.folderPath);
            push(roots, source.folder_path);
            push(roots, source.directoryPath);
            push(roots, source.directory_path);
            push(roots, source.dirPath);
            push(roots, source.dir_path);
            push(roots, source.rootPath);
            push(roots, source.root_path);
            push(patterns, source.filePattern);
            push(patterns, source.file_pattern);
            push(patterns, source.includePattern);
            push(patterns, source.include_pattern);
            push(patterns, source.glob);
            push(patterns, source.pattern);
        };

        collect(args);
        collect(args.parameters);
        collect(args.plannedAction);
        if (roots.length > 0) {
            return Array.from(new Set(roots));
        }

        return Array.from(new Set(patterns
            .map(pattern => this._searchRootFromPattern(pattern))
            .filter(Boolean)));
    }

    _searchRootFromPattern(rawPattern = '') {
        const pattern = String(rawPattern || '').trim();
        if (!pattern) {
            return '';
        }
        const globIndex = pattern.search(/[?*[\]{}]/u);
        const prefix = (globIndex >= 0 ? pattern.slice(0, globIndex) : pattern)
            .replace(/[\\/]+$/u, '');
        if (!prefix) {
            return '';
        }
        if (!path.isAbsolute(prefix) && !/[\\/]/u.test(prefix)) {
            return '';
        }
        return prefix;
    }

    _guardRequirementAnalyzerDemandArtifactAccess(name, args = {}, projectPath = '') {
        const parameters = args.parameters && typeof args.parameters === 'object' ? args.parameters : {};
        const skillName = this._normalizeSkillName(args.skillName || args.skill || args.role ||
            parameters.skillName || parameters.skill || parameters.role || '');
        if (skillName && skillName !== 'epoint-requirement-analyzer') {
            return null;
        }

        const toolName = this._normalizeToolName(name);
        const isAnalyzerStageWriteTool = ['fs_write', 'fs_append', 'str_replace'].includes(toolName);
        const isCommandTool = isCommandToolName(toolName);
        if (!isReadToolName(toolName) && !isWriteToolName(toolName) && !isAnalyzerStageWriteTool && !isCommandTool) {
            return null;
        }

        const targets = isCommandTool
            ? this._extractRequirementAnalyzerPathsFromCommand(args)
            : this._extractWritePathsForOwnedCheck(args);
        const uniqueTargets = Array.from(new Set(targets.map(item => String(item || '').trim()).filter(Boolean)));
        if (uniqueTargets.length === 0) {
            return null;
        }

        const effectiveProjectPath = this._resolveRequirementAnalyzerArtifactProjectPath(args, projectPath, uniqueTargets);
        if (!skillName && !effectiveProjectPath) {
            return null;
        }

        const projectArtifactsDir = path.join(String(effectiveProjectPath || '').trim(), '.ai-workspace', 'project');
        const activeDemandPath = path.join(projectArtifactsDir, '.active-demand');
        const hasActiveDemandTarget = uniqueTargets.some(item => this._sameResolvedPath(item, activeDemandPath));
        if (hasActiveDemandTarget && (isWriteToolName(toolName) || isAnalyzerStageWriteTool || isCommandTool)) {
            return this._blockedToolResponse('REQUIREMENT_ANALYZER_ACTIVE_DEMAND_WRITE_FORBIDDEN', [
                '物理拦截：.active-demand 只能由 req_prepare_context 受控创建或绑定，禁止需求分析阶段直接写入。',
                '[STOP]'
            ]);
        }

        const canonical = this._resolveRequirementAnalyzerCanonicalPaths(effectiveProjectPath);
        if (!canonical.ok) {
            const demandArtifactTarget = uniqueTargets.find(item => this._isRequirementAnalyzerDemandArtifactCandidate(item));
            if (!demandArtifactTarget) {
                return null;
            }
            return this._blockedToolResponse('REQUIREMENT_ANALYZER_CONTEXT_NOT_READY', [
                '物理拦截：epoint-requirement-analyzer 必须先成功调用 req_prepare_context，才能读写需求阶段产物。',
                `实际路径：${path.resolve(String(demandArtifactTarget || '').trim())}`,
                '无法从 .active-demand 解析 canonical fixedPaths。',
                '[STOP]'
            ]);
        }

        const hasDemandArtifactTarget = uniqueTargets.some(item => this._isRequirementAnalyzerDemandArtifactCandidate(item));
        const preparePass = this.requirementAnalyzerPreparePasses.get(this._projectKey(effectiveProjectPath));
        const preparedFixedPathKey = preparePass && preparePass.fixedPathKey;
        const currentFixedPathKey = this._requirementAnalyzerFixedPathKey(canonical.fixedPaths);
        if (hasDemandArtifactTarget && preparedFixedPathKey !== currentFixedPathKey) {
            return this._blockedToolResponse('REQUIREMENT_ANALYZER_PREPARE_CONTEXT_REQUIRED', [
                '物理拦截：epoint-requirement-analyzer 必须先成功调用 req_prepare_context，才能读写需求阶段产物。',
                preparedFixedPathKey
                    ? '当前 req_prepare_context 凭证已与 .active-demand 的 canonical fixedPaths 不一致，请重新调用 req_prepare_context。'
                    : '当前会话未记录 req_prepare_context(ok=true) 凭证。',
                '[STOP]'
            ]);
        }

        const builderOwnedGuard = this._guardRequirementAnalyzerBuilderOwnedWrite(name, args, toolName, uniqueTargets);
        if (builderOwnedGuard) {
            return builderOwnedGuard;
        }

        for (const targetPath of uniqueTargets) {
            const violation = this._classifyRequirementAnalyzerArtifactPath(targetPath, canonical);
            if (violation) {
                return this._blockedToolResponse('REQUIREMENT_ANALYZER_CANONICAL_PATH_REQUIRED', [
                    '物理拦截：epoint-requirement-analyzer 只能读写 req_prepare_context.fixedPaths 返回的需求阶段产物路径。',
                    `实际路径：${violation.actualPath}`,
                    `canonical 路径：${violation.expectedPath}`,
                    '请先调用 req_prepare_context(projectPath, skillName="epoint-requirement-analyzer")，并只使用返回的 fixedPaths。',
                    '[STOP]'
                ]);
            }
        }

        const jsonMutationGuard = this._guardRequirementAnalyzerJsonMutation(name, args, toolName, uniqueTargets, canonical);
        if (jsonMutationGuard) {
            return jsonMutationGuard;
        }

        return null;
    }

    _resolveRequirementAnalyzerArtifactProjectPath(args = {}, projectPath = '', targets = []) {
        const explicit = String(projectPath || '').trim();
        if (explicit) {
            return explicit;
        }
        for (const target of Array.isArray(targets) ? targets : []) {
            const resolved = path.resolve(String(target || '').trim());
            const projectFromArtifact = this._extractProjectPathFromArtifactPath(resolved);
            if (projectFromArtifact) {
                return projectFromArtifact;
            }
            if (/(?:^|[/\\])\.active-demand$/iu.test(resolved)) {
                const projectDir = path.dirname(resolved);
                if (path.basename(projectDir).toLowerCase() === 'project') {
                    const workspaceDir = path.dirname(projectDir);
                    if (path.basename(workspaceDir).toLowerCase() === '.ai-workspace') {
                        return path.dirname(workspaceDir);
                    }
                }
            }
        }
        const inferred = this._resolveRequirementAnalyzerHostProjectRoot(args, projectPath);
        return inferred || '';
    }

    _guardRequirementAnalyzerBuilderOwnedWrite(name, args = {}, toolName = '', targets = []) {
        const isAnalyzerStageWriteTool = ['fs_write', 'fs_append', 'str_replace'].includes(toolName);
        const isCommandTool = isCommandToolName(toolName);
        if (!isWriteToolName(toolName) && !isAnalyzerStageWriteTool && !isCommandTool) {
            return null;
        }
        const ownedTarget = (Array.isArray(targets) ? targets : [])
            .map(item => String(item || '').trim())
            .find(item => this._isRequirementAnalyzerBuilderOwnedDemandArtifact(item));
        if (!ownedTarget) {
            return null;
        }
        const basename = path.basename(path.resolve(ownedTarget));
        const guidance = this._requirementAnalyzerBuilderOwnedWriteGuidance(basename);
        return this._blockedToolResponse('REQUIREMENT_ANALYZER_BUILDER_OWNED_ARTIFACT_WRITE_FORBIDDEN', [
            `物理拦截：${basename} 是 Builder-owned 受控产物，禁止用 ${toolName || name} 直接写入或修改。`,
            `实际路径：${path.resolve(ownedTarget)}`,
            guidance,
            '[STOP]'
        ]);
    }

    _isRequirementAnalyzerBuilderOwnedDemandArtifact(targetPath = '') {
        if (!this._isRequirementAnalyzerDemandArtifactCandidate(targetPath)) {
            return false;
        }
        const basename = path.basename(path.resolve(String(targetPath || '').trim())).toLowerCase();
        return new Set([
            'stories.json',
            'stories-submit-receipt.json',
            'rule-pool.json',
            'rule-recall-raw.md',
            'rule-pool-draft-receipt.json',
            'rule-pool-rule-stage-receipt.json',
            'rule-pool-submit-receipt.json',
            'requirement-finalize-receipt.json'
        ]).has(basename);
    }

    _requirementAnalyzerBuilderOwnedWriteGuidance(basename = '') {
        const name = String(basename || '').toLowerCase();
        if (name === 'stories.json' || name === 'stories-submit-receipt.json') {
            return '正确恢复动作：只修本次 req_stories_submit 的 stories 入参，整组重调 req_stories_submit，由 Builder 重新落盘 stories.json 和 receipt/hash。';
        }
        if (name.startsWith('rule-pool') || name === 'rule-recall-raw.md') {
            return '正确恢复动作：按 req_rule_pool_build_rule_draft → req_rule_decision_submit → req_rule_pool_build_table_draft → req_table_decision_submit 继续或重跑规则池，禁止手写规则池。';
        }
        if (name === 'requirement-finalize-receipt.json') {
            return '正确恢复动作：修复上游需求产物后重调 req_finalize_artifacts，由 Finalizer 写入 receipt。';
        }
        return '正确恢复动作：回到上一个 MCP nextActionCard/allowedNextActions，调用对应 Builder 工具重建受控产物。';
    }

    _guardRequirementAnalyzerJsonMutation(name, args = {}, toolName = '', targets = [], canonical = {}) {
        const analysisStatePath = canonical && canonical.fixedPaths && canonical.fixedPaths.analysisStatePath;
        const target = (Array.isArray(targets) ? targets : [])
            .map(item => String(item || '').trim())
            .find(item => this._sameResolvedPath(item, analysisStatePath));
        if (!target) {
            return null;
        }

        const resolvedTarget = path.resolve(target);
        if (toolName === 'fs_append') {
            return this._blockedToolResponse('REQUIREMENT_ANALYZER_JSON_APPEND_FORBIDDEN', [
                `物理拦截：analysis-state.json 是 JSON 状态文件，禁止 fs_append 追加：${resolvedTarget}`,
                '正确动作：先调用 req_prepare_context 由 Builder 创建空白骨架；随后只允许 str_replace 精确替换，并且替换后的 JSON 必须可解析。',
                '[STOP]'
            ]);
        }

        if (['fs_write', 'write', 'write_to_file', 'edit_file'].includes(toolName)) {
            const exists = fs.existsSync(resolvedTarget);
            if (exists) {
                return this._blockedToolResponse('REQUIREMENT_ANALYZER_JSON_FULL_OVERWRITE_FORBIDDEN', [
                    `物理拦截：analysis-state.json 已存在，禁止用 ${toolName || name} 全量覆盖。`,
                    '这类覆盖最容易丢 Step 5 已确认事实并制造 JSON 语法错误；请 read_file/view_files 精确读取 fixedPaths.analysisStatePath 后用 str_replace 修改最小片段。',
                    '[STOP]'
                ]);
            }
            return this._blockedToolResponse('REQUIREMENT_ANALYZER_JSON_CREATE_FORBIDDEN', [
                `物理拦截：analysis-state.json 空白骨架只能由 req_prepare_context 创建：${resolvedTarget}`,
                '正确动作：调用 req_prepare_context，由 Builder 在 fixedPaths.analysisStatePath 原子创建唯一 stories 根；不要用 fs_write 自建分步根。',
                '[STOP]'
            ]);
        }

        if (toolName !== 'str_replace') {
            return null;
        }

        const pair = this._extractStrReplacePair(args);
        if (!pair || !pair.oldString) {
            return this._blockedToolResponse('REQUIREMENT_ANALYZER_JSON_REPLACE_SHAPE_INVALID', [
                '物理拦截：str_replace 修改 analysis-state.json 时必须提供 oldString/newString（或 old_string/new_string）以便预校验替换后的 JSON。',
                '[STOP]'
            ]);
        }
        if (!fs.existsSync(resolvedTarget)) {
            return this._blockedToolResponse('REQUIREMENT_ANALYZER_JSON_REPLACE_TARGET_MISSING', [
                `物理拦截：analysis-state.json 不存在，不能 str_replace：${resolvedTarget}`,
                '正确动作：重新调用 req_prepare_context，由 Builder 创建合法 analysis-state.json 空白骨架。',
                '[STOP]'
            ]);
        }

        const current = fs.readFileSync(resolvedTarget, 'utf-8');
        if (!current.includes(pair.oldString)) {
            return this._blockedToolResponse('REQUIREMENT_ANALYZER_JSON_REPLACE_ANCHOR_NOT_FOUND', [
                '物理拦截：analysis-state.json 中未找到 str_replace.oldString，禁止盲改 JSON。',
                '请重新 read_file/view_files 精确读取 fixedPaths.analysisStatePath，定位当前片段后再替换。',
                '[STOP]'
            ]);
        }
        const simulated = current.replace(pair.oldString, pair.newString);
        try {
            JSON.parse(simulated);
        } catch (error) {
            return this._blockedToolResponse('REQUIREMENT_ANALYZER_JSON_REPLACE_INVALID', [
                '物理拦截：本次 str_replace 会导致 analysis-state.json 变成非法 JSON。',
                `JSON.parse 错误：${error && error.message || error}`,
                '常见原因是字符串里写入未转义的英文双引号。请把业务文本作为 JSON 字符串转义后再替换，不要全量重写 analysis-state.json。',
                '[STOP]'
            ]);
        }
        return null;
    }

    _extractStrReplacePair(args = {}) {
        const parameters = args.parameters && typeof args.parameters === 'object' ? args.parameters : {};
        const oldCandidates = [
            args.oldString,
            args.old_string,
            args.search,
            args.find,
            args.old,
            parameters.oldString,
            parameters.old_string,
            parameters.search,
            parameters.find,
            parameters.old
        ];
        const newCandidates = [
            args.newString,
            args.new_string,
            args.replace,
            args.replacement,
            args.new,
            parameters.newString,
            parameters.new_string,
            parameters.replace,
            parameters.replacement,
            parameters.new
        ];
        const pick = values => {
            for (const value of values) {
                if (typeof value === 'string') return value;
            }
            return '';
        };
        return {
            oldString: pick(oldCandidates),
            newString: pick(newCandidates)
        };
    }

    _resolveRequirementAnalyzerCanonicalPaths(projectPath = '') {
        const root = String(projectPath || '').trim();
        if (!root) {
            return { ok: false };
        }

        const projectArtifactsDir = path.join(root, '.ai-workspace', 'project');
        const activeDemandPath = path.join(projectArtifactsDir, '.active-demand');
        if (!fs.existsSync(activeDemandPath)) {
            return { ok: false };
        }

        try {
            const demandName = String(fs.readFileSync(activeDemandPath, 'utf-8') || '').trim();
            if (!this._isValidDemandName(demandName)) {
                return { ok: false };
            }
            const demandDir = path.resolve(projectArtifactsDir, demandName);
            if (!this._isSameOrChild(demandDir, projectArtifactsDir)) {
                return { ok: false };
            }
            const demandArtifactDir = path.join(demandDir, 'demand');
            return {
                ok: true,
                fixedPaths: {
                    activeDemandPath,
                    demandAnalysisPath: path.join(demandArtifactDir, '需求分析.md'),
                    analysisStatePath: path.join(demandArtifactDir, 'analysis-state.json'),
                    ruleRecallRawPath: path.join(demandArtifactDir, 'rule-recall-raw.md'),
                    rulePoolPath: path.join(demandArtifactDir, 'rule-pool.json'),
                    finalizeReceiptPath: path.join(demandArtifactDir, 'requirement-finalize-receipt.json')
                }
            };
        } catch (_) {
            return { ok: false };
        }
    }

    _classifyRequirementAnalyzerArtifactPath(targetPath = '', canonical = {}) {
        const resolved = path.resolve(String(targetPath || '').trim());
        if (!this._isRequirementAnalyzerDemandArtifactCandidate(resolved)) {
            return null;
        }

        const allowedPaths = Object.values(canonical.fixedPaths || {}).filter(Boolean);
        if (allowedPaths.some(allowedPath => this._sameResolvedPath(resolved, allowedPath))) {
            return null;
        }

        const expectedByName = {
            '需求分析.md': canonical.fixedPaths && canonical.fixedPaths.demandAnalysisPath,
            'analysis-state.json': canonical.fixedPaths && canonical.fixedPaths.analysisStatePath,
            'rule-recall-raw.md': canonical.fixedPaths && canonical.fixedPaths.ruleRecallRawPath,
            'rule-pool.json': canonical.fixedPaths && canonical.fixedPaths.rulePoolPath,
            'requirement-finalize-receipt.json': canonical.fixedPaths && canonical.fixedPaths.finalizeReceiptPath
        };
        const expectedPath = expectedByName[path.basename(resolved)] || allowedPaths.join(' | ');
        return {
            actualPath: resolved,
            expectedPath
        };
    }

    _isRequirementAnalyzerDemandArtifactCandidate(targetPath = '') {
        const text = String(targetPath || '').trim();
        if (!text) {
            return false;
        }
        const resolved = path.resolve(text);
        const normalized = resolved.replace(/\\/g, '/');
        return normalized.includes('/demand/');
    }

    _extractRequirementAnalyzerPathsFromCommand(args = {}) {
        const parameters = args.parameters && typeof args.parameters === 'object' ? args.parameters : {};
        const command = String(args.command || args.cmd || args.pattern ||
            parameters.command || parameters.cmd || parameters.pattern || '');
        if (!command || !this._commandMutatesFile(command)) {
            return [];
        }

        const paths = [];
        const push = value => {
            const candidate = String(value || '').trim();
            if (candidate && (this._isRequirementAnalyzerDemandArtifactCandidate(candidate) || /(?:^|[/\\])\.active-demand$/iu.test(candidate))) {
                paths.push(candidate);
            }
        };

        const quoted = /["']([^"']*(?:[/\\]demand[/\\][^"']+|[/\\]\.active-demand))["']/giu;
        let match = null;
        while ((match = quoted.exec(command)) !== null) {
            push(match[1]);
        }

        const bare = /(^|[\s;&|])([^\s"';&|<>]*(?:[/\\]demand[/\\][^\s"';&|<>]+|[/\\]\.active-demand))/giu;
        while ((match = bare.exec(command)) !== null) {
            push(match[2]);
        }
        return Array.from(new Set(paths));
    }

    _guardDesignDocumentWrite(name, args = {}) {
        const toolName = this._normalizeToolName(name);
        const isWriteTool = isWriteToolName(toolName) || toolName === 'write_to_file';
        const isCommandTool = isCommandToolName(toolName);
        if (!isWriteTool && !isCommandTool) {
            return null;
        }

        if (isCommandTool) {
            const commandTarget = this._resolveDesignDocumentCommandTarget(args);
            if (!commandTarget) {
                return null;
            }
            return this._blockedToolResponse('DESIGN_FINAL_ARTIFACT_COMMAND_WRITE_FORBIDDEN', [
                `物理拦截：禁止用 ${toolName || name} 命令写入或移动最终设计产物：${commandTarget.targetPath}`,
                '最终 设计文档.md / 设计文档.json 只能由design_prepare_context在字段闭合并完成page_design_confirmed后自动预检、受控落盘。',
                '[STOP]'
            ]);
        }

        const target = this._resolveDesignDocumentWriteTarget(args);
        if (!target) {
            return null;
        }

        return this._blockedToolResponse('DESIGN_FINAL_ARTIFACT_DIRECT_WRITE_FORBIDDEN', [
            `物理拦截：禁止用 ${toolName || name} 直接写最终设计产物：${target.targetPath}`,
            '正确路径：无phase调用design_prepare_context建立或恢复currentStepId，按currentCardRef依次提交decisionRows、detailRows，并在字段闭合后用page_design_confirmed提交compositionRows；Builder只在页面设计通过后落盘。',
            'LLM不得独立提交最终设计对象，也不得自行拼接HtmlPage物理文件名。',
            '[STOP]'
        ]);
    }

    _resolveDesignDocumentWriteTarget(args = {}) {
        const writePaths = this._extractWritePathsForOwnedCheck(args);
        const targetPath = writePaths.find(item => /[/\\]设计文档\.(json|md)$/u.test(String(item || '').trim()));
        if (!targetPath) return null;
        return this._resolveDesignDocumentPath(targetPath);
    }

    _resolveDesignDocumentCommandTarget(args = {}) {
        const command = String(args && (args.command || args.cmd || args.pattern) || '');
        if (!command || !this._commandMutatesFile(command)) {
            return null;
        }
        const candidates = this._extractDesignDocumentPathsFromCommand(command);
        for (const candidate of candidates) {
            const target = this._resolveDesignDocumentPath(candidate);
            if (target) {
                return target;
            }
        }
        return null;
    }

    _commandMutatesFile(command = '') {
        const text = String(command || '');
        if (!text) return false;
        return this._commandWritesFile(text) ||
            /\b(Move-Item|Copy-Item|Rename-Item|mv|cp|move|copy|ren|rename)\b/iu.test(text);
    }

    _extractDesignDocumentPathsFromCommand(command = '') {
        const text = String(command || '');
        const paths = [];
        const push = value => {
            const candidate = String(value || '').trim();
            if (candidate && /设计文档\.(json|md)$/iu.test(candidate)) {
                paths.push(candidate);
            }
        };
        const quoted = /["']([^"']*设计文档\.(?:json|md))["']/giu;
        let match = null;
        while ((match = quoted.exec(text)) !== null) {
            push(match[1]);
        }
        const bare = /(^|[\s;&|])([^\s"';&|<>]*设计文档\.(?:json|md))/giu;
        while ((match = bare.exec(text)) !== null) {
            push(match[2]);
        }
        return Array.from(new Set(paths));
    }

    _resolveDesignDocumentPath(targetPath = '') {
        const resolved = path.resolve(String(targetPath || '').trim());
        const normalized = resolved.replace(/\\/g, '/');
        const marker = '/.ai-workspace/project/';
        const markerIndex = normalized.indexOf(marker);
        if (markerIndex < 0) return null;
        const suffix = normalized.slice(markerIndex + marker.length);
        const parts = suffix.split('/');
        if (parts.length !== 3 || parts[1] !== 'design' || !/^设计文档\.(json|md)$/u.test(parts[2])) {
            return null;
        }
        const projectPath = path.resolve(normalized.slice(0, markerIndex));
        const demandName = parts[0];
        const demandDir = path.join(projectPath, '.ai-workspace', 'project', demandName);
        const designDir = path.join(demandDir, 'design');
        return {
            projectPath,
            demandName,
            demandDir,
            designDir,
            targetPath: resolved,
            kind: parts[2].endsWith('.json') ? 'json' : 'md'
        };
    }

    _sameResolvedPath(a, b) {
        if (!a || !b) return false;
        return this._normalizeTarget(a) === this._normalizeTarget(b);
    }

    _artifactPathFromDir(dir = '', fileName = '') {
        const text = String(dir || '').trim();
        return text ? path.join(text, fileName) : '';
    }

    _loadJsonFromCandidates(candidates = []) {
        for (const candidate of candidates) {
            const filePath = String(candidate || '').trim();
            if (!filePath || !fs.existsSync(filePath)) {
                continue;
            }
            try {
                return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            } catch (_) {
                return null;
            }
        }
        return null;
    }





    // ─── Non-blocking human-readable delivery documentation ──────────────────

    installDocumentationGrant(projectPath = '', grantSpec = {}) {
        const projectRoot = path.resolve(String(projectPath || this.workspaceRoot || process.cwd()).trim());
        const outputRootText = String(grantSpec.outputRoot || '').trim();
        const manualRootText = String(grantSpec.manualRoot || '').trim();
        const outputRoot = outputRootText ? path.resolve(outputRootText) : '';
        const manualRoot = manualRootText ? path.resolve(manualRootText) : '';
        if (!outputRoot || !this._isSameOrChild(outputRoot, projectRoot)) {
            return { ok: false, reason: 'documentation_output_root_outside_project' };
        }
        const allowedDocumentationKinds = new Set([
            'previous_delivery_summary',
            'rest_source', 'rest_style_contract', 'previous_interface_document',
            'delivery_facts', 'workflow_artifacts_receipt', 'workflow_xml', 'design_finalize_receipt'
        ]);
        const hasReadableRefs = Array.isArray(grantSpec.readableRefs);
        const readableRefs = hasReadableRefs
            ? grantSpec.readableRefs.filter(ref => ref && allowedDocumentationKinds.has(
                String(ref.kind || '').trim().toLowerCase()
            ))
            : [];
        const readableCandidates = hasReadableRefs
            ? readableRefs.map(ref => ref.path).concat(
                Array.isArray(grantSpec.readableExtraFiles) ? grantSpec.readableExtraFiles : []
            )
            : (Array.isArray(grantSpec.readableFiles) ? grantSpec.readableFiles : []);
        const readableFiles = new Set(readableCandidates
            .map(filePath => this._normalizeTarget(filePath))
            .filter(Boolean));
        const grant = {
            projectPath: projectRoot,
            projectKey: this._projectKey(projectRoot),
            skillName: this._normalizeSkillName(
                grantSpec.skillName || this.activeSkill && this.activeSkill.skillName || ''
            ),
            readableFiles,
            outputRoot,
            manualRoot,
            installedAt: new Date().toISOString()
        };
        this.documentationGrants.set(grant.projectKey, grant);
        return { ok: true, outputRoot, readableFileCount: readableFiles.size };
    }

    clearDocumentationGrant(projectPath = '') {
        this.documentationGrants.delete(this._projectKey(projectPath));
    }

    _findDocumentationGrant(projectPath = '') {
        const direct = this.documentationGrants.get(this._projectKey(projectPath));
        if (direct) {
            return direct;
        }
        if (this.documentationGrants.size === 1) {
            return Array.from(this.documentationGrants.values())[0] || null;
        }
        return null;
    }

    _guardDeliveryDocumentationAccess(name, args = {}, projectPath = '') {
        const activeSkillName = this._normalizeSkillName(this.activeSkill && this.activeSkill.skillName || '');
        const grant = this._findDocumentationGrant(projectPath || this.lastDesignTddCoderProjectPath);
        if (!grant || grant.skillName && activeSkillName !== grant.skillName) {
            return null;
        }

        const toolName = this._normalizeToolName(name);
        if (isSearchToolName(toolName) || isCommandToolName(toolName)) {
            return {
                blocked: this._blockedToolResponse('DESIGN_TDD_DOCUMENTATION_SEARCH_FORBIDDEN', [
                    '人读交付文档只能读取 documentationTaskCardRef、deliveryFactsRef、documentationTaskCard.inputRefs、deliverySummaryTemplateRef/templateRef 的精确路径，禁止搜索、枚举目录或运行命令补材料。',
                    '正常路径必须按卡片生成 delivery/generated；若文档工具失败，只报告 warning 后继续正式流程，不得主动跳过。',
                    '[STOP]'
                ], {
                    actionMode: 'repair_or_warn_delivery_documentation',
                    allowedNextActions: ['read_documentation_task_card_exact_inputs', 'report_documentation_warning_then_continue_stage'],
                    forbiddenActions: ['search_project_for_documentation_inputs']
                })
            };
        }

        if (isReadToolName(toolName)) {
            const targets = this._extractReadPathsForOwnedCheck(args)
                .map(target => this._normalizeTarget(this._resolveTargetInsideProject(target, grant.projectPath)))
                .filter(Boolean);
            if (targets.length > 0 && targets.every(target => grant.readableFiles.has(target))) {
                return { allowed: true };
            }
            return {
                blocked: this._blockedToolResponse('DESIGN_TDD_DOCUMENTATION_READ_SCOPE_VIOLATION', [
                    `人读交付文档读取目标不在 documentationTaskCard 精确输入白名单：${targets.join(', ') || '(missing path)'}`,
                    '只允许读取 documentationTaskCardRef.path、deliveryFactsRef.path、inputRefs[].path、deliverySummaryTemplateRef.path 与 templateRef.path；缺失内容写“未发现/未生成”，禁止搜索补齐。',
                    '[STOP]'
                ], {
                    allowedNextActions: ['read_documentation_task_card_exact_inputs', 'report_documentation_warning_then_continue_stage'],
                    forbiddenActions: ['search_project_for_documentation_inputs']
                })
            };
        }

        const isDeleteTool = ['delete_file', 'remove_file', 'fs_delete', 'delete_path'].includes(toolName);
        const isDocumentationWriteTool = isWriteToolName(toolName) ||
            ['fs_write', 'str_replace', 'write_to_file'].includes(toolName) ||
            isDeleteTool;
        if (!isDocumentationWriteTool) {
            return null;
        }

        const targets = this._extractWritePathsForOwnedCheck(args)
            .map(target => this._resolveTargetInsideProject(target, grant.projectPath))
            .filter(Boolean);
        const allInsideGenerated = targets.length > 0 && targets.every(target =>
            this._isSameOrChild(target, grant.outputRoot) &&
            (!grant.manualRoot || !this._isSameOrChild(target, grant.manualRoot)));
        if (allInsideGenerated) {
            return { allowed: true };
        }

        return {
            blocked: this._blockedToolResponse('DESIGN_TDD_DOCUMENTATION_WRITE_SCOPE_VIOLATION', [
                `人读交付文档只允许写当前需求 delivery/generated：${grant.outputRoot}`,
                grant.manualRoot ? `delivery/manual 永不允许修改：${grant.manualRoot}` : '',
                `本次写入目标：${targets.join(', ') || '(missing path)'}`,
                '[STOP]'
            ], {
                allowedNextActions: ['write_delivery_generated_only', 'report_documentation_warning_then_continue_stage'],
                forbiddenActions: ['write_outside_delivery_generated', 'modify_delivery_manual']
            })
        };
    }

    _normalizeToolArgCandidates(args = {}) {
        const candidates = [];
        const pushObject = (value) => {
            if (!value || typeof value !== 'object' || Array.isArray(value)) return;
            if (!candidates.includes(value)) candidates.push(value);
        };

        pushObject(args);
        pushObject(args.parameters);
        pushObject(args.arguments);
        pushObject(args.params);
        pushObject(args.params && args.params.arguments);
        pushObject(args.params && args.params.parameters);

        const merged = {};
        for (const candidate of candidates) {
            Object.assign(merged, candidate);
        }
        delete merged.parameters;
        delete merged.arguments;
        delete merged.params;
        pushObject(merged);

        return candidates;
    }

    _extractToolProjectPath(args = {}) {
        // 优先级（v3）：
        //  1. 显式 args.projectPath（最高，已声明就是项目根）
        //  2. args.outputDir 中含 .ai-workspace 时反推上一级
        //  3. 其他文件路径（filePath/constructionPlanPath/...）反推
        //  4. workspaceRoot / cwd 兜底
        // 拒绝结果若为插件仓库根（包含 vscode插件-projectrules / mcp_tools 路径片段），
        // 视为无效绑定，回退 workspaceRoot，避免把插件仓库误判为业务项目根。
        const parameters = args.parameters && typeof args.parameters === 'object' ? args.parameters : {};
        const direct = String(args.projectPath || parameters.projectPath || '').trim();
        if (direct) {
            return this._guardAgainstPluginRoot(path.resolve(direct));
        }
        const workingDir = String(args.workdir || args.cwd || parameters.workdir || parameters.cwd || '').trim();
        if (workingDir) {
            return this._guardAgainstPluginRoot(path.resolve(workingDir));
        }
        // outputDir 单独优先于其他文件路径（R2C 工具绝大多数都传 outputDir）
        const outputDirRaw = String(args.outputDir || parameters.outputDir || '').trim();
        if (outputDirRaw) {
            const fromOutputDir = this._extractProjectPathFromArtifactPath(outputDirRaw);
            if (fromOutputDir) {
                return this._guardAgainstPluginRoot(fromOutputDir);
            }
        }
        const planned = args.plannedAction && typeof args.plannedAction === 'object' ? args.plannedAction : {};
        const filePath = String(
            args.filePath ||
            args.file_path ||
            args.path ||
            args.targetFile ||
            args.target_file ||
            args.target ||
            args.targetPath ||
            args.target_path ||
            args.outputPath ||
            args.output_path ||
            args.filePattern ||
            args.file_pattern ||
            args.folderPath ||
            args.folder_path ||
            args.directoryPath ||
            args.directory_path ||
            args.dirPath ||
            args.dir_path ||
            args.rootPath ||
            args.root_path ||
            args.constructionPlanPath ||
            args.constructionPlanMarkdownPath ||
            args.databaseDesignPath ||
            parameters.filePath ||
            parameters.file_path ||
            parameters.path ||
            parameters.targetFile ||
            parameters.target_file ||
            parameters.target ||
            parameters.targetPath ||
            parameters.target_path ||
            parameters.outputPath ||
            parameters.output_path ||
            parameters.filePattern ||
            parameters.file_pattern ||
            parameters.folderPath ||
            parameters.folder_path ||
            parameters.directoryPath ||
            parameters.directory_path ||
            parameters.dirPath ||
            parameters.dir_path ||
            parameters.rootPath ||
            parameters.root_path ||
            parameters.constructionPlanPath ||
            parameters.constructionPlanMarkdownPath ||
            parameters.databaseDesignPath ||
            planned.filePath ||
            planned.file_path ||
            planned.path ||
            planned.target ||
            planned.targetFile ||
            planned.target_file ||
            planned.targetPath ||
            planned.target_path ||
            planned.reportPath ||
            planned.outputDir ||
            ''
        ).trim();
        if (!filePath) {
            return this._guardAgainstPluginRoot(this.workspaceRoot || process.cwd());
        }
        const projectPath = this._extractProjectPathFromArtifactPath(filePath);
        if (projectPath) {
            return this._guardAgainstPluginRoot(projectPath);
        }
        if (path.basename(path.resolve(filePath)).toLowerCase() === '.ai-workspace') {
            return this._guardAgainstPluginRoot(path.dirname(path.resolve(filePath)));
        }
        return this._guardAgainstPluginRoot(this.workspaceRoot || process.cwd());
    }

    /**
     * 防御：解析结果若指向插件仓库自身（vscode插件-projectrules / mcp_tools），
     * 这是错配；回退 workspaceRoot 让 lock 至少不会污染插件根。
     */
    _guardAgainstPluginRoot(candidatePath = '') {
        const resolved = path.resolve(candidatePath || '');
        const lower = resolved.toLowerCase();
        const pluginMarkers = [
            `${path.sep}mcp_tools${path.sep}`.toLowerCase(),
            `${path.sep}mcp_tools`.toLowerCase()
        ];
        // vscode插件-projectrules 这种中文目录名要先做 normalize 比较
        const hasPluginRoot = pluginMarkers.some(marker => lower.endsWith(marker) || lower.includes(marker))
            || lower.includes('vscode插件-projectrules'.toLowerCase());
        if (hasPluginRoot) {
            return path.resolve(this.workspaceRoot || process.cwd());
        }
        return resolved;
    }

    _extractProjectPathFromArtifactPath(filePath = '') {
        const resolved = path.resolve(filePath);
        const marker = `${path.sep}.ai-workspace${path.sep}`;
        const index = resolved.indexOf(marker);
        if (index >= 0) {
            return resolved.slice(0, index);
        }
        return '';
    }

    _projectKey(projectPath = '') {
        return this._normalizeTarget(projectPath || this.workspaceRoot || process.cwd());
    }

    _normalizeSkillName(value) {
        return normalizeToolName(value);
    }

    _normalizeToolName(value) {
        return String(value || '').trim().toLowerCase();
    }

    _buildReferenceFiles(referencesRoot = '', supplied = {}) {
        if (supplied && typeof supplied === 'object' && !Array.isArray(supplied) && Object.keys(supplied).length > 0) {
            return { ...supplied };
        }
        return {};
    }

    _detectPlatform() {
        if (process.platform === 'win32') {
            return 'windows-powershell';
        }
        if (process.platform === 'darwin') {
            return 'macos';
        }
        return 'linux';
    }

    _normalizePlanPath(filePath, projectPath) {
        const text = String(filePath || '').trim();
        if (!text) {
            return '';
        }
        if (path.isAbsolute(text)) {
            return path.resolve(text);
        }
        return path.resolve(projectPath || this.workspaceRoot || process.cwd(), text);
    }

    _isSameOrChild(child, parent) {
        if (!child || !parent) {
            return false;
        }
        const comparableChild = this._normalizeTarget(child);
        const comparableParent = this._normalizeTarget(parent);
        return comparableChild === comparableParent || comparableChild.startsWith(comparableParent + path.sep);
    }

    _normalizeTarget(value) {
        const text = String(value || '').trim();
        if (!text) {
            return '';
        }
        const normalized = path.resolve(text);
        return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    }

    _safeJsonStringify(value) {
        try {
            return JSON.stringify(value || {});
        } catch (_) {
            return String(value || '');
        }
    }

    _resolveBundledSkillRoot(skillName = '') {
        const name = String(skillName || '').trim();
        if (!name) {
            return '';
        }
        const candidates = [];
        const envRoot = String(process.env.EPOINT_SKILLS_ROOT || '').trim();
        if (envRoot) {
            candidates.push(path.join(envRoot, name));
        }
        candidates.push(path.resolve(__dirname, '..', '..', '..', 'skills', name));
        return candidates.find(candidate => candidate && fs.existsSync(candidate)) || '';
    }

    _blockedToolResponse(code, lines = [], options = {}) {
        const actionMode = String(options.actionMode || 'runtime_guard_blocked').trim();
        const requiresRepair = options.repairRequired === true || actionMode === 'repair_current_coding_patch';
        const allowedNextActions = Array.isArray(options.allowedNextActions) ? options.allowedNextActions : [];
        const forbiddenActions = Array.isArray(options.forbiddenActions) ? options.forbiddenActions : [];
        return {
            content: [{
                type: 'text',
                text: [
                    `# Skill Runtime Tool Gate: ${requiresRepair ? 'repair_required' : 'blocked'}`,
                    '',
                    `- code: ${code}`,
                    '- ok: false',
                    `- actionMode: ${actionMode}`,
                    `- allowedNextActions: ${JSON.stringify(allowedNextActions)}`,
                    `- forbiddenActions: ${JSON.stringify(forbiddenActions)}`,
                    '',
                    ...lines
                ].join('\n')
            }],
            isError: true
        };
    }
}

module.exports = SkillRuntimeToolGuardService;
