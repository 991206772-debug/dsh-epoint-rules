/* eslint-disable */
const fs = require('fs');

class RequirementAnalysisMarkdownRendererService {
    render(requirementPaths = {}, analysisState = {}) {
        const demandName = String(requirementPaths.demandName || '').trim() || '需求分析';
        const storiesRead = this._readJsonIfExists(requirementPaths.storiesPath);
        const rulePoolRead = this._readJsonIfExists(requirementPaths.rulePoolPath);
        const stories = storiesRead.ok && storiesRead.value && Array.isArray(storiesRead.value.stories)
            ? storiesRead.value.stories
            : this._analysisStateStoriesForMarkdown(analysisState);
        const rulePool = rulePoolRead.ok && rulePoolRead.value && typeof rulePoolRead.value === 'object'
            ? rulePoolRead.value
            : {};
        const today = new Date().toISOString().slice(0, 10);
        const lines = [];

        lines.push('# 需求分析文档');
        lines.push('');
        lines.push(`> 需求名称：${demandName}`);
        lines.push(`> 生成日期：${today}`);
        lines.push('> 本文档由 `req_finalize_artifacts` 根据 `analysis-state.json`、`stories.json` 与 `rule-pool.json` 自动生成。机器合同以 JSON 产物为准。');
        lines.push('');
        lines.push('---');
        lines.push('');

        this._renderActors(lines, stories);
        this._renderStories(lines, stories);
        this._renderActorStoryMatrix(lines, stories);
        this._renderAcceptance(lines, stories);
        this._renderInvariants(lines, stories);
        this._renderHandoff(lines, stories);
        this._renderSideEffects(lines, stories);
        this._renderAmbiguities(lines, analysisState);
        this._renderRulePool(lines, rulePool);
        this._renderFinalCheck(lines);

        return `${lines.join('\n')}\n`;
    }

    _renderActors(lines, stories) {
        lines.push('## 1. Actor 列表');
        lines.push('');
        const actorMap = new Map();
        stories.forEach(story => {
            const actor = String(story.actor || '').trim() || '未标明 Actor';
            if (!actorMap.has(actor)) actorMap.set(actor, []);
            actorMap.get(actor).push(String(story.storyId || '').trim());
        });
        if (actorMap.size === 0) {
            lines.push('（未识别到 Actor）');
        } else {
            lines.push('| Actor | 来源 Story |');
            lines.push('|---|---|');
            actorMap.forEach((ids, actor) => {
                lines.push(`| ${this._mdCell(actor)} | ${this._mdCell(ids.filter(Boolean).join('、'))} |`);
            });
        }
        lines.push('');
    }

    _renderStories(lines, stories) {
        lines.push('## 2. User Story');
        lines.push('');
        if (stories.length === 0) {
            lines.push('（未提交结构化 Story）');
        } else {
            stories.forEach(story => {
                lines.push(`**${this._mdCell(story.storyId || '')}**: ${this._mdCell(story.userStory || story.intent || '')}`);
                this._renderExistingAdjustment(lines, story.existingAdjustment);
                lines.push('');
            });
        }
    }

    _renderExistingAdjustment(lines, existingAdjustment) {
        const existing = existingAdjustment && typeof existingAdjustment === 'object' ? existingAdjustment : null;
        if (!existing) return;
        const entryFiles = Array.isArray(existing.entryFiles)
            ? existing.entryFiles.map(item => typeof item === 'string' ? item : (item && item.path)).filter(Boolean)
            : [];
        const preserveBehaviors = Array.isArray(existing.preserveBehaviors)
            ? existing.preserveBehaviors.map(item => typeof item === 'string' ? item : (item && item.businessResult)).filter(Boolean)
            : [];
        if (entryFiles.length > 0) lines.push(`- 既有入口：${this._mdCell(entryFiles.join('、'))}`);
        if (preserveBehaviors.length > 0) lines.push(`- 保持行为：${this._mdCell(preserveBehaviors.join('、'))}`);
    }

    _renderActorStoryMatrix(lines, stories) {
        lines.push('## 2.5 Actor-Story 矩阵');
        lines.push('');
        if (stories.length === 0) {
            lines.push('（无）');
        } else {
            lines.push('| Story | Actor | 业务目标 | 触发依赖 |');
            lines.push('|---|---|---|---|');
            stories.forEach(story => {
                lines.push(`| ${this._mdCell(story.storyId)} | ${this._mdCell(story.actor || '')} | ${this._mdCell(story.userStory || story.intent || '')} | ${this._mdCell(story.triggerDependency || '用户触发')} |`);
            });
        }
        lines.push('');
    }

    _renderAcceptance(lines, stories) {
        lines.push('## 3. 验收标准');
        lines.push('');
        stories.forEach(story => {
            lines.push(`### ${this._mdCell(story.storyId || '')}`);
            lines.push('');
            const ac = story.acceptanceCriteria && typeof story.acceptanceCriteria === 'object' ? story.acceptanceCriteria : {};
            [
                ['Happy Path', ac.happyPath],
                ['异常', ac.exception],
                ['边界', ac.boundary]
            ].forEach(([label, items]) => {
                lines.push(`#### ${label}`);
                const rows = Array.isArray(items) ? items : [];
                if (rows.length === 0) {
                    lines.push('- （无）');
                } else {
                    lines.push('| 场景 | Given | When | Then |');
                    lines.push('|---|---|---|---|');
                    rows.forEach(item => {
                        lines.push(`| ${this._mdCell(item && item.scenario)} | ${this._mdCell(item && item.given)} | ${this._mdCell(item && item.when)} | ${this._mdCell(item && item.then)} |`);
                    });
                }
                lines.push('');
            });
        });
    }

    _renderInvariants(lines, stories) {
        lines.push('## 4. 业务不变量');
        lines.push('');
        const invariants = [];
        stories.forEach(story => {
            (Array.isArray(story.invariants) ? story.invariants : []).forEach(item => {
                invariants.push({ storyId: story.storyId, text: String(item || '').trim() });
            });
        });
        if (invariants.length === 0) {
            lines.push('（无跨 Story 业务不变量）');
        } else {
            invariants.forEach(item => lines.push(`- [${this._mdCell(item.storyId)}] ${this._mdCell(item.text)}`));
        }
        lines.push('');
    }

    _renderHandoff(lines, stories) {
        lines.push('## 4.2 公司业务机制与编码事实交接');
        lines.push('');
        const handoffRows = [];
        stories.forEach(story => {
            this._collectCodingFactRows(story, handoffRows);
        });
        if (handoffRows.length === 0) {
            lines.push('（无额外交接事实）');
        } else {
            lines.push('| Story | 类型 | 内容 |');
            lines.push('|---|---|---|');
            handoffRows.forEach(row => {
                lines.push(`| ${this._mdCell(row.storyId)} | ${this._mdCell(row.type)} | ${this._mdCell(row.text)} |`);
            });
        }
        lines.push('');
    }

    _collectCodingFactRows(story, out) {
        if (Array.isArray(story.codingFactHandoff) && story.codingFactHandoff.length > 0) {
            story.codingFactHandoff.forEach(item => {
                out.push({
                    storyId: story.storyId,
                    type: item && item.factType || 'codingFactHandoff',
                    text: item && (item.fact || item.summary || item.description || item.value) || ''
                });
            });
        }
    }

    _renderSideEffects(lines, stories) {
        lines.push('## 4.5 业务副作用清单');
        lines.push('');
        const sideEffects = [];
        stories.forEach(story => {
            const candidates = []
                .concat(Array.isArray(story.sideEffects) ? story.sideEffects : [])
                .concat(Array.isArray(story.businessSideEffects) ? story.businessSideEffects : []);
            candidates.forEach(item => sideEffects.push({
                storyId: story.storyId,
                text: String(item && (item.businessResult || item.summary || item) || '').trim()
            }));
        });
        if (sideEffects.length === 0) {
            lines.push('（无独立副作用；以各 Story 验收标准和业务形态交接为准）');
        } else {
            sideEffects.forEach(item => lines.push(`- [${this._mdCell(item.storyId)}] ${this._mdCell(item.text)}`));
        }
        lines.push('');
    }

    _renderAmbiguities(lines, analysisState) {
        lines.push('## 5. 业务模糊点审查与确认');
        lines.push('');
        const ambiguities = this._requirementMarkdownAmbiguities(analysisState);
        if (ambiguities.length === 0) {
            lines.push('无待用户拍板的业务模糊点，或已在 Story 事实中完成消化。');
        } else {
            lines.push('| 模糊点 | 状态 | 净化业务结论 | 流程影响 | 影响 Story |');
            lines.push('|---|---|---|---|---|');
            ambiguities.forEach(item => {
                lines.push(`| ${this._mdCell(item.title)} | ${this._mdCell(item.status)} | ${this._mdCell(item.businessDecision)} | ${this._mdCell(item.flowImpact)} | ${this._mdCell(item.affectsStories.join('、'))} |`);
            });
        }
        lines.push('');
    }

    _renderRulePool(lines, rulePool) {
        lines.push('## 6. 规则召回与表候选');
        lines.push('');
        const recalls = Array.isArray(rulePool.storyRuleRecalls) ? rulePool.storyRuleRecalls : [];
        if (recalls.length === 0) {
            lines.push('（规则池尚无 Story 召回明细）');
        } else {
            lines.push('| Story | 已确认规则 | 未解决提示 | 表候选 |');
            lines.push('|---|---|---|---|');
            recalls.forEach(recall => {
                const rules = this._names(recall.acceptedRules, ['alias', 'ruleName', 'name']);
                const signals = this._names(recall.unresolvedSignals, ['signal', 'name', 'reason']);
                const tables = this._names(recall.projectTableCandidates, ['tableName', 'name']);
                lines.push(`| ${this._mdCell(recall.storyId)} | ${this._mdCell(rules.join('、') || '-')} | ${this._mdCell(signals.join('、') || '-')} | ${this._mdCell(tables.join('、') || '-')} |`);
            });
        }
        const keptTables = Array.isArray(rulePool.globalTableCandidateWhitelist) ? rulePool.globalTableCandidateWhitelist : [];
        if (keptTables.length > 0) {
            lines.push('');
            lines.push(`已确认复用表候选：${this._names(keptTables, ['tableName', 'name']).map(item => this._mdCell(item)).join('、')}`);
        }
        lines.push('');
    }

    _renderFinalCheck(lines) {
        lines.push('## 6.5 最终自检');
        lines.push('');
        lines.push('- Story 机器合同：`stories.json`');
        lines.push('- 规则池机器合同：`rule-pool.json`');
        lines.push('- 需求阶段状态：`analysis-state.json`');
        lines.push('- 本 Markdown 仅做人读展示，不作为下游机器真值。');
        lines.push('');
    }

    _analysisStateStoriesForMarkdown(analysisState = {}) {
        const raw = analysisState && analysisState.stories;
        if (Array.isArray(raw)) return raw;
        if (raw && typeof raw === 'object') {
            return Object.entries(raw).map(([storyId, value]) => ({
                ...(value && typeof value === 'object' ? value : {}),
                storyId: String((value && value.storyId) || storyId || '').trim()
            }));
        }
        return [];
    }

    _requirementMarkdownAmbiguities(analysisState = {}) {
        const out = [];
        const visit = (value) => {
            if (!value) return;
            if (Array.isArray(value)) {
                value.forEach(visit);
                return;
            }
            if (typeof value !== 'object') return;
            const title = String(value.fuzzyPoint || value.question || value.title || value.id || '').trim();
            const status = String(value.status || value.confirmStatus || '').trim();
            const hasAmbiguityShape = title && (status || value.businessDecision || value.flowImpact || value.affectsStories);
            if (hasAmbiguityShape) {
                out.push({
                    title,
                    status,
                    businessDecision: String(value.businessDecision || value.businessDecisionSummary || value.cleanBusinessDecision || '').trim(),
                    flowImpact: String(value.flowImpact || value.businessFlowImpact || value.processImpact || '').trim(),
                    affectsStories: Array.isArray(value.affectsStories)
                        ? value.affectsStories.map(v => String(v || '').trim()).filter(Boolean)
                        : []
                });
            }
        };
        visit(analysisState.ambiguityPoints);
        visit(analysisState.ambiguityCards);
        return out;
    }

    _names(items, keys = []) {
        if (!Array.isArray(items)) return [];
        return items.map(item => {
            if (typeof item === 'string') return item;
            if (!item || typeof item !== 'object') return '';
            for (const key of keys) {
                if (item[key]) return String(item[key]);
            }
            return '';
        }).map(v => String(v || '').trim()).filter(Boolean);
    }

    _readJsonIfExists(filePath) {
        if (!filePath || !fs.existsSync(filePath)) return { ok: false, exists: false, value: null };
        try {
            return { ok: true, exists: true, value: JSON.parse(fs.readFileSync(filePath, 'utf-8')) };
        } catch (error) {
            return { ok: false, exists: true, value: null, error };
        }
    }

    _mdCell(value = '') {
        return String(value === undefined || value === null ? '' : value)
            .replace(/\|/g, '\\|')
            .replace(/\r?\n/g, '<br>')
            .trim();
    }
}

module.exports = RequirementAnalysisMarkdownRendererService;
