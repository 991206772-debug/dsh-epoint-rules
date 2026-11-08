class QuestionCardDisplayRenderer {
    renderFinalQuestionScreen(plan = {}) {
        const questionCards = Array.isArray(plan.questionCards) ? plan.questionCards : [];
        const openCards = questionCards.filter(card => !this._hasAnswerResolution(plan, this._questionId(card)));
        if (openCards.length === 0) {
            return '';
        }
        return [
            '请直接回复以下问题',
            '',
            ...openCards.flatMap((card, index) => this._renderQuestionCard(card, index))
        ].join('\n').trimEnd();
    }

    renderQuestionSummary(plan = {}) {
        const questionCards = Array.isArray(plan.questionCards) ? plan.questionCards : [];
        const answerResolutions = Array.isArray(plan.answerResolutions) ? plan.answerResolutions : [];
        const blockers = Array.isArray(plan.blockers) ? plan.blockers : [];
        const unresolvedSignals = Array.isArray(plan.unresolvedSignals) ? plan.unresolvedSignals : [];
        const lines = [];
        if (questionCards.length === 0 && answerResolutions.length === 0 && blockers.length === 0 && unresolvedSignals.length === 0) {
            return ['- 无未闭合问题。'];
        }
        questionCards.forEach((card, index) => {
            const questionId = this._questionId(card) || `QC-${index + 1}`;
            const answer = this._answerResolution(plan, questionId);
            lines.push(`- ${this._escape(questionId)}：${this._escape(card.question || card.title || card.userQuestion || '未命名问题')}`);
            lines.push(`  - status：${answer ? 'answered' : this._escape(card.status || card.state || 'open')}`);
            if (card.suggestedAnswer || card.recommendedAnswer || card.recommendation) {
                lines.push(`  - 推荐：${this._escape(card.suggestedAnswer || card.recommendedAnswer || card.recommendation)}`);
            }
            if (answer) {
                lines.push(`  - 用户回答：${this._escape(answer.confirmedAnswer || answer.answer || answer.selectedAnswer || '已回答')}`);
                (Array.isArray(answer.decisions) ? answer.decisions : []).forEach(decision => {
                    lines.push(`  - 决策：${this._escape(decision.targetPath || decision.target || 'unknown')} => ${this._shortJson(decision.payload || decision.value || {})}`);
                });
            }
        });
        const questionIds = new Set(questionCards.map(card => this._questionId(card)).filter(Boolean));
        answerResolutions
            .filter(answer => !questionIds.has(String(answer && (answer.questionId || answer.id || answer.questionCardId) || '').trim()))
            .forEach((answer, index) => {
                lines.push(`- answerResolution#${index + 1}：${this._escape(answer.questionId || answer.id || 'EMPTY')} -> ${this._escape(answer.confirmedAnswer || answer.answer || '已回答')}`);
            });
        unresolvedSignals.forEach(signal => {
            lines.push(`- unresolvedSignal：${this._escape(signal.signal || signal.userAnchor || signal.reason || this._shortJson(signal))}`);
        });
        blockers.forEach(blocker => {
            lines.push(`- blocker：${this._escape(blocker.code || blocker.blockerId || 'BLOCKER')}：${this._escape(blocker.message || blocker.reason || '')}`);
        });
        return lines;
    }

    _renderQuestionCard(card = {}, index = 0) {
        const questionId = this._questionId(card) || `QC-${index + 1}`;
        const title = this._escape(card.title || card.questionTitle || card.category || '问题确认');
        const question = this._escape(card.question || card.userQuestion || card.message || '请确认该问题。');
        const options = this._normalizeOptions(card);
        const lines = [
            `### ${this._escape(questionId)}：${title}`,
            '',
            `- 问题：${question}`
        ];
        const hierarchy = this._hierarchyLines(card);
        if (hierarchy.length > 0) {
            lines.push('- 展示层级：');
            hierarchy.forEach(line => lines.push(`  ${line}`));
        }
        if (options.length > 0) {
            lines.push('- 可选答案：');
            options.forEach(option => {
                const impact = option.impact || option.description || option.text || '';
                lines.push(`  - ${this._escape(option.id)}. ${this._escape(option.label || option.value || option.id)}${impact ? `：${this._escape(impact)}` : ''}`);
            });
        }
        const suggested = this._suggestedAnswer(card, options);
        lines.push(`- 推荐最优方案：${this._escape(suggested || '证据不足，需用户确认')}`);
        lines.push(`- 推荐原因：${this._escape(card.recommendReason || card.recommendationReason || card.reason || '证据不足，需用户确认。')}`);
        lines.push(`- 为什么必须回答：${this._escape(card.answerImpact || card.impact || card.requiredReason || card.requiredAction || '该答案会影响后续施工单结构化决策。')}`);
        lines.push('');
        return lines;
    }

    _hierarchyLines(card = {}) {
        const explicit = card.displayHierarchy || card.uiHierarchy || card.surfaceHierarchy || card.hierarchy;
        if (Array.isArray(explicit) && explicit.length > 0) {
            return explicit.map(item => this._escape(typeof item === 'string' ? item : (item && (item.label || item.title || item.name) || this._shortJson(item)))).filter(Boolean);
        }
        if (typeof explicit === 'string' && explicit.trim()) {
            return explicit.split(/\r?\n/u).map(line => this._escape(line.trim())).filter(Boolean);
        }
        const root = card.sourcePage || card.pageName || card.page || card.currentPage || card.listPage || card.surfaceName || card.sourceSurface || '';
        const entry = card.entryName || card.buttonName || card.triggerName || card.trigger || '';
        const target = card.openTarget || card.targetPage || card.dialogName || card.resultPage || card.targetSurface || card.carrier || '';
        const rowActions = Array.isArray(card.rowActions) ? card.rowActions : (Array.isArray(card.operations) ? card.operations : []);
        if (!root && !entry && !target && rowActions.length === 0) {
            return [];
        }
        const lines = [];
        lines.push(`${this._escape(root || '当前页面/列表')}（${this._escape(card.pageDescription || card.surfaceDescription || '承载入口')}）`);
        if (entry || target || rowActions.length > 0) {
            lines.push(`├─ ${this._escape(entry || '按钮/入口')}（${this._escape(card.entryArea || card.position || card.containerRole || 'toolbar/list_toolbar/page_toolbar/operation_area')}）`);
        }
        if (target || rowActions.length > 0) {
            lines.push(`│  └─ 打开 ${this._escape(target || '页面/弹窗/结果页')}（${this._escape(card.targetDescription || card.carrierDescription || '承载结果')}）`);
        }
        rowActions.forEach((action, actionIndex) => {
            const prefix = actionIndex === rowActions.length - 1 ? '│     └─' : '│     ├─';
            const label = typeof action === 'string' ? action : (action && (action.label || action.name || action.title || action.action) || `行操作${actionIndex + 1}`);
            const desc = typeof action === 'object' && action ? (action.description || action.impact || action.type || '') : '';
            lines.push(`${prefix} ${this._escape(label)}${desc ? `（${this._escape(desc)}）` : ''}`);
        });
        return lines;
    }

    _normalizeOptions(card = {}) {
        const raw = Array.isArray(card.options) ? card.options : (Array.isArray(card.allowedAnswers) ? card.allowedAnswers : []);
        return raw.map((option, index) => {
            const fallbackId = index >= 0 && index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
            if (option && typeof option === 'object') {
                return {
                    id: String(option.id || option.code || option.key || fallbackId).trim(),
                    label: String(option.label || option.value || option.name || option.text || '').trim(),
                    impact: String(option.impact || option.description || option.reason || '').trim()
                };
            }
            return {
                id: fallbackId,
                label: String(option || '').trim(),
                impact: ''
            };
        }).filter(option => option.label || option.id);
    }

    _suggestedAnswer(card = {}, options = []) {
        const raw = String(card.suggestedAnswer || card.recommendedAnswer || card.recommendation || '').trim();
        if (!raw) return '';
        const match = options.find(option =>
            raw === option.id ||
            raw === option.label ||
            raw.toLowerCase() === String(option.id || '').toLowerCase() ||
            raw.toLowerCase() === String(option.label || '').toLowerCase());
        return match ? `${match.id}. ${match.label || raw}` : raw;
    }

    _questionId(card = {}) {
        return String(card && (card.questionId || card.id || card.cardId) || '').trim();
    }

    _answerResolution(plan = {}, questionId = '') {
        const target = String(questionId || '').trim();
        if (!target) return null;
        return (Array.isArray(plan.answerResolutions) ? plan.answerResolutions : []).find(answer => {
            const id = String(answer && (answer.questionId || answer.id || answer.questionCardId) || '').trim();
            return id === target;
        }) || null;
    }

    _hasAnswerResolution(plan = {}, questionId = '') {
        const answer = this._answerResolution(plan, questionId);
        if (!answer) return false;
        const confirmedAnswer = String(answer.confirmedAnswer || answer.answer || answer.selectedAnswer || '').trim();
        const decisions = Array.isArray(answer.decisions) ? answer.decisions : [];
        return Boolean(confirmedAnswer || decisions.length > 0);
    }

    _shortJson(value) {
        const text = typeof value === 'string' ? value : JSON.stringify(value || {});
        return this._escape(text.length > 220 ? `${text.slice(0, 217)}...` : text);
    }

    _escape(value = '') {
        return String(value || '').replace(/\r?\n/gu, ' ').trim();
    }
}

module.exports = QuestionCardDisplayRenderer;
