/* eslint-disable */
const fs = require('fs');
const path = require('path');

class DesignProjectContextResolver {
    resolve(inputPath = '') {
        const raw = String(inputPath || '').trim();
        if (!raw) {
            return this._blocked('DESIGN_PROJECT_CONTEXT_PATH_MISSING', '缺少 projectPath；压缩恢复至少需要工程根、需求目录或受管卡片路径之一。');
        }
        const absoluteInput = path.resolve(raw);
        const candidateRoots = this._candidateRoots(absoluteInput);
        const failures = [];
        for (const candidateRoot of candidateRoots) {
            const resolved = this._resolveRoot(candidateRoot, absoluteInput);
            if (resolved.ok) return resolved;
            failures.push(resolved);
        }
        const firstFailure = failures[0];
        if (firstFailure && firstFailure.errorCode === 'DESIGN_PROJECT_CONTEXT_ACTIVE_DEMAND_MISSING'
            && fs.existsSync(absoluteInput) && fs.statSync(absoluteInput).isDirectory()) {
            return {
                ...firstFailure,
                actionMode: 'switch_to_requirement_analyzer',
                message: `工程根缺少Requirement需求锚点：${firstFailure.activeDemandPath}。切换到epoint-requirement-analyzer调用req_prepare_context；禁止手写.active-demand。`,
                nextActionCard: {
                    title: '先建立Requirement需求锚点',
                    instruction: '切换到epoint-requirement-analyzer，根据用户需求派生2-8字中文demandName后调用以下工具。',
                    callTemplate: `req_prepare_context(${JSON.stringify({
                        projectPath: absoluteInput,
                        skillName: 'epoint-requirement-analyzer',
                        demandName: 'TEMPLATE_FILL_REQUIRED'
                    })})`
                },
                allowedNextActions: ['switch_to_requirement_analyzer_and_call_req_prepare_context'],
                forbiddenActions: ['create_active_demand', 'create_nested_ai_workspace', 'search_other_demand_directories']
            };
        }
        const hintedRoot = this._rootBeforeWorkspaceMarker(absoluteInput);
        return this._blocked(
            'DESIGN_PROJECT_CONTEXT_UNRESOLVED',
            `无法从受管路径解析业务项目根：${absoluteInput}。禁止创建 .active-demand 或嵌套 .ai-workspace。`,
            {
                inputPath: absoluteInput,
                retryWith: hintedRoot ? { projectPath: hintedRoot, phase: 'entry' } : undefined,
                attemptedRoots: candidateRoots,
                failures: failures.slice(0, 4).map(item => ({ errorCode: item.errorCode, activeDemandPath: item.activeDemandPath }))
            }
        );
    }

    _candidateRoots(absoluteInput) {
        const out = [];
        const push = value => {
            const normalized = path.resolve(value);
            const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
            if (!out.some(item => (process.platform === 'win32' ? item.toLowerCase() : item) === key)) out.push(normalized);
        };
        const markerRoot = this._rootBeforeWorkspaceMarker(absoluteInput);
        if (markerRoot) push(markerRoot);
        let current = fs.existsSync(absoluteInput) && fs.statSync(absoluteInput).isDirectory()
            ? absoluteInput
            : path.dirname(absoluteInput);
        for (let depth = 0; depth < 16; depth += 1) {
            push(current);
            const parent = path.dirname(current);
            if (parent === current) break;
            current = parent;
        }
        return out;
    }

    _rootBeforeWorkspaceMarker(absoluteInput) {
        const normalized = absoluteInput.replace(/\\/g, '/');
        const marker = '/.ai-workspace/project/';
        const index = normalized.toLowerCase().indexOf(marker);
        if (index < 0) return '';
        return path.resolve(normalized.slice(0, index));
    }

    _resolveRoot(projectRoot, absoluteInput) {
        const projectPath = path.resolve(projectRoot);
        const projectArtifactsDir = path.join(projectPath, '.ai-workspace', 'project');
        const activeDemandPath = path.join(projectArtifactsDir, '.active-demand');
        if (!fs.existsSync(activeDemandPath)) {
            return this._blocked('DESIGN_PROJECT_CONTEXT_ACTIVE_DEMAND_MISSING', `候选工程根缺少 .active-demand：${activeDemandPath}`, {
                projectPath,
                activeDemandPath
            });
        }
        const demandName = String(fs.readFileSync(activeDemandPath, 'utf8') || '').trim();
        if (!demandName) {
            return this._blocked('DESIGN_PROJECT_CONTEXT_ACTIVE_DEMAND_EMPTY', `.active-demand 为空：${activeDemandPath}`, {
                projectPath,
                activeDemandPath
            });
        }
        const demandDir = path.resolve(projectArtifactsDir, demandName);
        if (!this._isSameOrChild(demandDir, projectArtifactsDir)) {
            return this._blocked('DESIGN_PROJECT_CONTEXT_DEMAND_OUTSIDE_PROJECT', `.active-demand 指向非法目录：${demandName}`, {
                projectPath,
                activeDemandPath,
                demandName
            });
        }
        if (!fs.existsSync(demandDir)) {
            return this._blocked('DESIGN_PROJECT_CONTEXT_DEMAND_DIR_MISSING', `当前需求目录不存在：${demandDir}`, {
                projectPath,
                activeDemandPath,
                demandName,
                demandDir
            });
        }
        const inputIsProjectRoot = path.resolve(absoluteInput) === projectPath;
        const inputIsManagedDemandPath = this._isSameOrChild(absoluteInput, demandDir);
        if (!inputIsProjectRoot && !inputIsManagedDemandPath) {
            return this._blocked(
                'DESIGN_PROJECT_CONTEXT_INPUT_NOT_MANAGED',
                `输入路径既不是工程根，也不在当前需求目录内：${absoluteInput}`,
                { projectPath, demandDir, inputPath: absoluteInput }
            );
        }
        const designDir = path.join(demandDir, 'design');
        const runtimeDir = path.join(designDir, '.runtime');
        const deliveryRuntimeDir = path.join(demandDir, 'delivery', '.runtime');
        return {
            ok: true,
            projectPath,
            inputPath: absoluteInput,
            inputNormalized: path.resolve(absoluteInput) !== projectPath,
            projectArtifactsDir,
            activeDemandPath,
            demandName,
            demandDir,
            demandDirIsInputAncestor: this._isSameOrChild(absoluteInput, demandDir) || this._isSameOrChild(demandDir, absoluteInput),
            demandArtifactDir: path.join(demandDir, 'demand'),
            storiesPath: path.join(demandDir, 'demand', 'stories.json'),
            storiesReceiptPath: path.join(demandDir, 'demand', 'stories-submit-receipt.json'),
            analysisStatePath: path.join(demandDir, 'demand', 'analysis-state.json'),
            rulePoolPath: path.join(demandDir, 'demand', 'rule-pool.json'),
            rulePoolReceiptPath: path.join(demandDir, 'demand', 'rule-pool-submit-receipt.json'),
            navigationCompactPath: path.join(projectArtifactsDir, '工程导航契约.compact.json'),
            navigationPath: path.join(projectArtifactsDir, '工程导航契约.json'),
            frameworkBucketPath: path.join(projectArtifactsDir, '框架版本档位.json'),
            designDir,
            runtimeDir,
            deliveryRuntimeDir,
            deliveryFactsPath: path.join(deliveryRuntimeDir, 'delivery-facts.json'),
            documentationTaskCardPath: path.join(deliveryRuntimeDir, 'documentation-task-card.json'),
            workflowStatePath: path.join(runtimeDir, 'design-workflow-state.json'),
            canonicalModelPath: path.join(runtimeDir, 'canonical-model-draft.json'),
            currentCardPath: path.join(runtimeDir, 'current-card.json'),
            designJsonPath: path.join(designDir, '设计文档.json'),
            designMarkdownPath: path.join(designDir, '设计文档.md'),
            designStatePath: path.join(designDir, 'design-state.json'),
            finalizeReceiptPath: path.join(designDir, 'design-finalize-receipt.json')
        };
    }

    _isSameOrChild(candidate, parent) {
        const rel = path.relative(path.resolve(parent), path.resolve(candidate));
        return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
    }

    _blocked(errorCode, message, extra = {}) {
        return {
            ok: false,
            status: 'blocked',
            actionMode: 'call_design_prepare_context_with_managed_path',
            errorCode,
            message,
            allowedNextActions: ['retry_design_prepare_context_with_project_root_or_managed_path'],
            forbiddenActions: ['create_active_demand', 'create_nested_ai_workspace', 'search_other_demand_directories'],
            ...extra
        };
    }
}

module.exports = DesignProjectContextResolver;
