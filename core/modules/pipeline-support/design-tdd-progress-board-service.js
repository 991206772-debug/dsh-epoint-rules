/* eslint-disable */
/**
 * DesignTddProgressBoardService — Builder-owned 进度看板维护
 *
 * 故事线：用户经常要在长跑任务里"打开 plan 文件就能看到进度"，但纯 LLM 自己写表
 * 难免漏列、错列、覆盖。这里 Builder 用最小动作维护看板：
 *   - design_tdd_build_plan 首次落盘 plan.md 时，渲染空看板（全 ⬜）
 *   - design_tdd_skeleton_materialize 物化成功后调 markCell(skeleton)，骨架列打 ✅
 *   - 骨架完成后不再由 Builder 按 Story 推进状态；Coder 把稳定批次写入 plan，把当前状态和验证结果写入 progress
 *
 * v2 简化（2026-05）：取消 TDD 红绿环节，只保留骨架完成状态
 *
 *   原因：骨架阶段不负责业务测试编排，编码阶段由 Coder 根据连续业务批次自行选择测试和编译验证。
 *   核心价值是让人一眼看到骨架是否完成；业务完成情况由 Coder 的实施计划和真实验证记录负责。
 *
 * 关键设计取舍（AGENTS.md 红线）：
 *   - 不加新 MCP 工具（"返回瘦身"）：服务方法被现有工具调用
 *   - 不写新 schema 文件（"不复制合同"）：表格列定义只在 _renderProgressBoard 一处
 *   - Builder-owned 骨架列由本服务直接 str_replace；不让 LLM 手写表格
 *   - 失败不阻断（看板更新失败不让骨架物化也失败）：所有方法 try/catch 静默
 */
const fs = require('fs');

const PROGRESS_BOARD_BEGIN = '<!-- progress-board:begin -->';
const PROGRESS_BOARD_END = '<!-- progress-board:end -->';
const COLUMNS = ['skeleton'];
const COLUMN_TITLES = {
    skeleton: '骨架'
};
const STATUS_TODO = '⬜';
const STATUS_DONE = '✅';
const STATUS_IN_PROGRESS = '🟡';

class DesignTddProgressBoardService {

    _isWorkflowProcessScene(item = {}) {
        return String(
            item && (
                item.constructionSceneKey
                || (item.businessContext && item.businessContext.constructionSceneKey)
            ) || ''
        ).trim() === 'workflow_process';
    }

    _isCarriedOnlyModule(item = {}) {
        const carriedByModuleId = String(
            item && (
                item.carriedByModuleId
                || (item.businessContext && item.businessContext.carriedByModuleId)
            ) || ''
        ).trim();
        return Boolean(carriedByModuleId) && !this._isWorkflowProcessScene(item);
    }

    /**
     * 渲染初始进度看板 Markdown 段（包含 begin/end 锚点，方便后续 str_replace）。
     *
     * @param {Array<{ moduleId, moduleName, bizModule, carriedByModuleId? }>} modulePlans
     * @returns {string}
     */
    renderInitialBoard(modulePlans = []) {
        const lines = [];
        lines.push(PROGRESS_BOARD_BEGIN);
        lines.push('');
        lines.push('## 2. 模块进度看板');
        lines.push('');
        lines.push('> 由 Builder 自动维护：');
        lines.push('> - **骨架** 列：`design_tdd_skeleton_materialize` 物化所有 owner 文件后自动打 ✅');
        lines.push('> - **状态** 列：骨架 ✅ 时改为 `DONE`；进行中改为 `IN_PROGRESS`；未开始为 `TODO`');
        lines.push('> - 编码完成以实施计划中的真实变更和验证记录为准');
        lines.push('');
        lines.push('| 模块 | 业务名 | 骨架 | 状态 |');
        lines.push('|---|---|---|---|');
        modulePlans.forEach(item => {
            const moduleId = String(item.moduleId || '').trim();
            const moduleName = String(item.moduleName || '').trim();
            const bizModule = String(item.bizModule || '').trim();
            const carried = String(item.carriedByModuleId || '').trim();
            const carriedOnly = this._isCarriedOnlyModule(item);
            const labelDetail = bizModule
                ? (carried ? `${moduleName}（承载于 ${carried}, ${bizModule}）` : `${moduleName}（${bizModule}）`)
                : moduleName;
            // 承载模块的进度跟随父模块，本身只占位不打勾
            if (carriedOnly) {
                lines.push(`| ${this._mdCell(moduleId)} | ${this._mdCell(labelDetail)} | - | CARRIED |`);
            } else {
                lines.push(`| ${this._mdCell(moduleId)} | ${this._mdCell(labelDetail)} | ${STATUS_TODO} | TODO |`);
            }
        });
        lines.push('');
        lines.push('| 汇总 | — | 0 / 总数 | — |');
        lines.push('');
        lines.push(PROGRESS_BOARD_END);
        return lines.join('\n');
    }

    /**
     * 标记某模块的某列状态。
     *
     * @param {string} planPath design-tdd-plan.md 的路径
     * @param {string} moduleId 如 MOD-01
     * @param {string} column skeleton
     * @param {string} status STATUS_TODO | STATUS_IN_PROGRESS | STATUS_DONE
     * @returns {{ ok: boolean, message?: string, planPath: string }}
     */
    markCell(planPath, moduleId, column, status) {
        const requestedColumn = column;
        try {
            if (!planPath || !fs.existsSync(planPath)) {
                return { ok: false, planPath, message: 'plan 文件不存在' };
            }
            if (!moduleId) {
                return { ok: false, planPath, message: 'moduleId 必填' };
            }
            if (!COLUMNS.includes(requestedColumn)) {
                return { ok: false, planPath, message: `column 必须是 ${COLUMNS.join('/')} 之一` };
            }
            const validStatus = [STATUS_TODO, STATUS_IN_PROGRESS, STATUS_DONE];
            if (!validStatus.includes(status)) {
                return { ok: false, planPath, message: `status 必须是 ${validStatus.join('/')} 之一` };
            }
            const original = fs.readFileSync(planPath, 'utf-8');
            const updated = this._updateBoardInMarkdown(original, moduleId, requestedColumn, status);
            if (updated === original) {
                return { ok: false, planPath, message: `未找到模块 ${moduleId} 在进度看板中的行` };
            }
            fs.writeFileSync(planPath, updated, 'utf-8');
            return { ok: true, planPath };
        } catch (error) {
            return { ok: false, planPath, message: error.message };
        }
    }

    /**
     * 查询当前进度看板中某模块状态，供人查看摘要。
     *
     * @returns {{ ok: boolean, modules: Array<{moduleId, moduleName, skeleton, overall}> }}
     */
    readBoard(planPath) {
        try {
            if (!planPath || !fs.existsSync(planPath)) {
                return { ok: false, modules: [] };
            }
            const content = fs.readFileSync(planPath, 'utf-8');
            const boardSection = this._extractBoardSection(content);
            if (!boardSection) {
                return { ok: false, modules: [] };
            }
            const modules = [];
            const lines = boardSection.split(/\r?\n/);
            for (const line of lines) {
                // 跳过表头/分隔/汇总行
                if (!/^\|\s*MOD-/.test(line)) continue;
                const cells = line.split('|').map(c => c.trim()).filter((_, idx) => idx > 0 && idx < 5);
                if (cells.length < 4) continue;
                modules.push({
                    moduleId: cells[0],
                    moduleName: cells[1],
                    skeleton: cells[2],
                    overall: cells[3]
                });
            }
            return { ok: true, modules };
        } catch (error) {
            return { ok: false, modules: [], message: error.message };
        }
    }

    /**
     * 计算汇总：返回 X/总数 的字符串，给 LLM 在 Final Response 里复用。
     *
     * @returns {{ ok: boolean, summary?: { total, skeletonDone, allDone } }}
     */
    computeSummary(planPath) {
        const board = this.readBoard(planPath);
        if (!board.ok) return { ok: false };
        const trackable = board.modules.filter(m => m.overall !== 'CARRIED');
        const total = trackable.length;
        const skeletonDone = trackable.filter(m => m.skeleton === STATUS_DONE).length;
        const allDone = trackable.filter(m => m.overall === 'DONE').length;
        return {
            ok: true,
            summary: { total, skeletonDone, allDone }
        };
    }

    _updateBoardInMarkdown(content, moduleId, column, status) {
        const startIdx = content.indexOf(PROGRESS_BOARD_BEGIN);
        const endIdx = content.indexOf(PROGRESS_BOARD_END);
        if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) return content;
        const before = content.slice(0, startIdx);
        const board = content.slice(startIdx, endIdx + PROGRESS_BOARD_END.length);
        const after = content.slice(endIdx + PROGRESS_BOARD_END.length);

        const columnIdx = COLUMNS.indexOf(column);
        const lines = board.split(/\r?\n/);
        let touched = false;
        const updated = lines.map(line => {
            // 模块行匹配：以 | MOD-XX | 起始
            if (!new RegExp(`^\\|\\s*${escapeRegex(moduleId)}\\s*\\|`).test(line)) return line;
            const cells = line.split('|');
            // cells: [ '', ' MOD-01 ', ' 业务名 ', ' 骨架 ', ' 状态 ', '' ]
            if (cells.length < 6) return line;
            // 承载模块行不更新（用 - 占位）
            if (/^\s*-\s*$/.test(cells[3])) return line;
            cells[3 + columnIdx] = ` ${status} `;
            // 重新计算 overall
            const skeleton = cells[3].trim();
            const allDone = skeleton === STATUS_DONE;
            const anyInProgress = skeleton === STATUS_IN_PROGRESS || skeleton === STATUS_DONE;
            cells[4] = ` ${allDone ? 'DONE' : (anyInProgress ? 'IN_PROGRESS' : 'TODO')} `;
            touched = true;
            return cells.join('|');
        }).join('\n');

        if (!touched) return content;
        // 重新计算汇总行
        const recomputed = this._refreshSummaryRow(updated);
        return before + recomputed + after;
    }

    _refreshSummaryRow(boardSection) {
        const lines = boardSection.split(/\r?\n/);
        let total = 0;
        const counts = { skeleton: 0 };
        lines.forEach(line => {
            if (!/^\|\s*MOD-/.test(line)) return;
            const cells = line.split('|').map(c => c.trim());
            if (cells.length < 6) return;
            // 承载行（- -）不计入 total
            if (cells[3] === '-' && cells[4] === 'CARRIED') return;
            total += 1;
            if (cells[3] === STATUS_DONE) counts.skeleton += 1;
        });
        return lines.map(line => {
            if (!/^\|\s*汇总\s*\|/.test(line)) return line;
            return `| 汇总 | — | ${counts.skeleton} / ${total} | — |`;
        }).join('\n');
    }

    _extractBoardSection(content) {
        const startIdx = content.indexOf(PROGRESS_BOARD_BEGIN);
        const endIdx = content.indexOf(PROGRESS_BOARD_END);
        if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) return null;
        return content.slice(startIdx, endIdx + PROGRESS_BOARD_END.length);
    }

    _mdCell(value = '') {
        return String(value == null ? '' : value)
            .replace(/\r?\n/gu, '<br>')
            .replace(/\|/gu, '\\|');
    }
}

function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

DesignTddProgressBoardService.STATUS_TODO = STATUS_TODO;
DesignTddProgressBoardService.STATUS_IN_PROGRESS = STATUS_IN_PROGRESS;
DesignTddProgressBoardService.STATUS_DONE = STATUS_DONE;
DesignTddProgressBoardService.COLUMNS = COLUMNS;
DesignTddProgressBoardService.COLUMN_TITLES = COLUMN_TITLES;
DesignTddProgressBoardService.PROGRESS_BOARD_BEGIN = PROGRESS_BOARD_BEGIN;
DesignTddProgressBoardService.PROGRESS_BOARD_END = PROGRESS_BOARD_END;

module.exports = DesignTddProgressBoardService;
