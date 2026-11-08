/* eslint-disable */

class PromptContextBudget {
    constructor(options = {}) {
        this.defaultMaxChars = Number.isInteger(options.defaultMaxChars) && options.defaultMaxChars > 0
            ? options.defaultMaxChars
            : 60000;
    }

    /**
     * 结构化预算治理：按 P0/P1/P2 优先级分层裁剪
     * @param {object} structuredInput - 结构化输入块
     * @param {object} options - 预算选项
     * @returns {object} { text, diagnostics }
     */
    applyStructured(structuredInput = {}, options = {}) {
        const maxChars = Number.isInteger(options.maxChars) && options.maxChars > 0
            ? options.maxChars
            : this.defaultMaxChars;
        const label = String(options.label || 'structured_prompt').trim();

        // P0: 永不裁剪
        const p0 = this._renderPriorityBlock(structuredInput.p0 || {}, 'P0');
        // P1: 只允许压缩为路径索引
        const p1 = this._renderPriorityBlock(structuredInput.p1 || {}, 'P1');
        // P2: 可摘要化或裁剪，但必须保留来源路径
        const p2 = this._renderPriorityBlock(structuredInput.p2 || {}, 'P2');

        const parts = [
            p0.rendered,
            p1.rendered,
            p2.rendered
        ].filter(Boolean);

        let text = parts.join('\n\n');
        const originalChars = text.length;

        // 裁剪策略：先尝试压缩 P2，再压缩 P1
        const trimmedSections = [];
        let p2Trimmed = '';
        if (text.length > maxChars) {
            if (p2.canTrim) {
                p2Trimmed = this._trimP2Block(structuredInput.p2 || {}, p2.rendered);
                if (p2Trimmed && p2Trimmed.length < p2.rendered.length) {
                    trimmedSections.push('P2');
                    text = [p0.rendered, p1.rendered, p2Trimmed].filter(Boolean).join('\n\n');
                }
            }
        }
        if (text.length > maxChars) {
            if (p1.canTrim) {
                const p1Trimmed = this._trimP1Block(structuredInput.p1 || {}, p1.rendered);
                if (p1Trimmed && p1Trimmed.length < p1.rendered.length) {
                    trimmedSections.push('P1');
                    text = [p0.rendered, p1Trimmed, p2Trimmed || p2.rendered].filter(Boolean).join('\n\n');
                }
            }
        }

        const diagnostics = {
            version: 2,
            label,
            maxChars,
            originalChars,
            finalChars: text.length,
            overBudget: text.length > maxChars,
            trimmedSections,
            trimPolicy: 'structured_p0_p1_p2',
            p0Chars: p0.chars,
            p1Chars: p1.chars,
            p2Chars: p2.chars
        };

        if (diagnostics.overBudget && options.blockOnOverBudget === true) {
            return {
                text: [
                    '# ERROR: PROMPT_CONTEXT_BUDGET_EXCEEDED',
                    '',
                    `label: ${label}`,
                    `maxChars: ${maxChars}`,
                    `finalChars: ${text.length}`,
                    `trimmedSections: ${trimmedSections.length > 0 ? trimmedSections.join('、') : '无'}`,
                    '',
                    '当前 prompt 在按 P0→P1→P2 分层裁剪后仍超出预算。',
                    'P0 块（硬指令/mustRead/mustWrite/STOP/nextAction）永不裁剪。',
                    '请继续瘦身 mustRead 指向的大文件或改为读取 compact/摘要，禁止继续生成污染上下文。'
                ].join('\n'),
                diagnostics: { ...diagnostics, blocked: true }
            };
        }

        if (trimmedSections.length > 0 || options.alwaysAppendDiagnostics === true) {
            text = `${text.trimEnd()}\n\n## Prompt Budget Diagnostics\n- label: ${label}\n- originalChars: ${originalChars}\n- finalChars: ${diagnostics.finalChars}\n- maxChars: ${maxChars}\n- trimmedSections: ${trimmedSections.length > 0 ? trimmedSections.join('、') : '无'}\n- trimPolicy: structured_p0_p1_p2\n`;
        }

        return { text, diagnostics };
    }

    _renderPriorityBlock(block, priority) {
        const rendered = this._renderBlock(block);
        return {
            rendered,
            chars: rendered.length,
            canTrim: priority !== 'P0'
        };
    }

    _renderBlock(block) {
        if (typeof block === 'string') return block;
        if (!block || typeof block !== 'object') return '';
        const parts = [];
        if (block.role) parts.push(`# Role: ${block.role}`);
        if (block.objective) parts.push(`> **目标**: ${block.objective}`);
        if (Array.isArray(block.hardBans) && block.hardBans.length > 0) {
            parts.push('## 硬禁止规则（违反即阻断）');
            block.hardBans.forEach(b => parts.push(`- ${b}`));
        }
        if (Array.isArray(block.mustRead) && block.mustRead.length > 0) {
            parts.push('## mustRead');
            block.mustRead.forEach((p, i) => parts.push(`${i + 1}. \`${p}\``));
        }
        if (Array.isArray(block.mustWrite) && block.mustWrite.length > 0) {
            parts.push('## mustWrite');
            block.mustWrite.forEach((p, i) => parts.push(`${i + 1}. \`${p}\``));
        }
        if (block.stopBlock) parts.push(String(block.stopBlock));
        if (block.nextAction) parts.push(`## nextAction\n${block.nextAction}`);
        if (Array.isArray(block.contextPaths) && block.contextPaths.length > 0) {
            parts.push('## 上下文路径');
            block.contextPaths.forEach((p, i) => parts.push(`${i + 1}. \`${p}\``));
        }
        if (Array.isArray(block.ruleDigests) && block.ruleDigests.length > 0) {
            parts.push('## 规则摘要');
            block.ruleDigests.forEach(d => parts.push(`- ${d.ruleName}: ${d.digestHash}`));
        }
        if (Array.isArray(block.batchCards) && block.batchCards.length > 0) {
            parts.push('## 当前 batch 施工卡');
            block.batchCards.forEach(c => parts.push(c));
        }
        if (block.body) parts.push(String(block.body));
        return parts.join('\n\n');
    }

    _trimP2Block(raw, rendered) {
        if (typeof raw === 'string') {
            return `[budget-trimmed:P2] 原始内容已裁剪，来源: ${raw.slice(0, 80)}...`;
        }
        if (!raw || typeof raw !== 'object') return rendered;
        // 保留路径索引，裁剪正文
        const paths = Array.isArray(raw.contextPaths) ? raw.contextPaths : [];
        const digests = Array.isArray(raw.ruleDigests) ? raw.ruleDigests : [];
        const lines = ['## P2 内容已摘要化'];
        if (paths.length > 0) {
            lines.push('- 上下文路径:');
            paths.forEach(p => lines.push(`  - \`${p}\``));
        }
        if (digests.length > 0) {
            lines.push('- 规则摘要索引:');
            digests.forEach(d => lines.push(`  - ${d.ruleName}: ${d.digestHash}`));
        }
        return lines.join('\n');
    }

    _trimP1Block(raw, rendered) {
        if (typeof raw === 'string') {
            return `[budget-trimmed:P1] 原始内容已压缩为路径索引，来源: ${raw.slice(0, 80)}...`;
        }
        if (!raw || typeof raw !== 'object') return rendered;
        const paths = Array.isArray(raw.contextPaths) ? raw.contextPaths : [];
        const lines = ['## P1 内容已压缩为路径索引'];
        if (paths.length > 0) {
            paths.forEach(p => lines.push(`- \`${p}\``));
        }
        return lines.join('\n');
    }

    analyzeStageSnapshot(snapshot = {}, options = {}) {
        const maxChars = Number.isInteger(options.maxChars) && options.maxChars > 0
            ? options.maxChars
            : this.defaultMaxChars;
        const blocks = [];
        const addBlock = (name, value, priority = 'normal') => {
            if (value === undefined || value === null) return;
            blocks.push({
                name,
                priority,
                chars: this._measureChars(value),
                omitted: this._isOmitted(value),
                reason: this._buildReason(name, value, priority)
            });
        };

        addBlock('prompt', snapshot.prompt, 'strong');
        addBlock('validate', snapshot.validate, 'strong');
        addBlock('templates', snapshot.templates, 'stage-critical');
        addBlock('requirementRulesContext', snapshot.requirementRulesContext, 'stage-critical');
        addBlock('projectRetrieval', snapshot.projectRetrieval, 'context');
        addBlock('businessGraph', snapshot.businessGraph, 'context');
        addBlock('renderedDrafts', snapshot.renderedDrafts, 'diagnostic');
        addBlock('internalStages', snapshot.internalStages, 'diagnostic');

        const totalChars = blocks.reduce((sum, item) => sum + item.chars, 0);
        const omittedBlocks = blocks.filter(item => item.omitted).map(item => item.name);
        const largestBlocks = [...blocks]
            .sort((left, right) => right.chars - left.chars)
            .slice(0, 5)
            .map(item => ({ name: item.name, chars: item.chars, priority: item.priority }));
        return {
            version: 1,
            maxChars,
            totalChars,
            overBudget: totalChars > maxChars,
            omittedBlocks,
            largestBlocks,
            blockCount: blocks.length,
            blocks
        };
    }

    applyToStageSnapshot(snapshot = {}, options = {}) {
        const maxChars = Number.isInteger(options.maxChars) && options.maxChars > 0
            ? options.maxChars
            : this.defaultMaxChars;
        const result = { ...(snapshot && typeof snapshot === 'object' ? snapshot : {}) };
        const trimmedBlocks = [];
        let diagnostics = this.analyzeStageSnapshot(result, { maxChars });
        const trimOrder = [
            { name: 'internalStages', marker: '[budget-omitted:internalStages]' },
            { name: 'renderedDrafts', marker: '[budget-omitted:renderedDrafts]' },
            { name: 'businessGraph', marker: '[budget-omitted:businessGraph]' },
            { name: 'projectRetrieval', marker: '[budget-omitted:projectRetrieval]' }
        ];

        for (const item of trimOrder) {
            if (!diagnostics.overBudget) break;
            if (result[item.name] === undefined || result[item.name] === item.marker) continue;
            result[item.name] = item.marker;
            trimmedBlocks.push(item.name);
            diagnostics = this.analyzeStageSnapshot(result, { maxChars });
        }

        result.promptContextBudget = {
            ...diagnostics,
            trimmedBlocks,
            trimPolicy: 'diagnostic_and_context_only'
        };
        return result;
    }

    applyToPromptText(promptText = '', options = {}) {
        const maxChars = Number.isInteger(options.maxChars) && options.maxChars > 0
            ? options.maxChars
            : this.defaultMaxChars;
        let text = String(promptText || '').replace(/\r\n/g, '\n');
        const originalChars = text.length;
        const trimmedSections = [];
        const lowPriorityHeadings = (Array.isArray(options.lowPriorityHeadings) ? options.lowPriorityHeadings : [
            '## 项目自然语言候选',
            '## 已加载规则上下文',
            '## CORE PROTOCOLS (核心防护规约)',
            '## Coder 施工合同 / Design Dispatch Plan v2',
            '## 🔒 Assembly Gate Checks / 装配门禁检查'
        ]).map(item => String(item || '').trim()).filter(Boolean);

        for (const heading of lowPriorityHeadings) {
            if (text.length <= maxChars) break;
            const result = this._replacePromptSection(text, heading, `[budget-omitted-section:${heading.replace(/^#+\s*/, '')}]`);
            if (!result.changed) continue;
            text = result.text;
            trimmedSections.push(heading);
        }

        const diagnostics = {
            version: 1,
            label: String(options.label || 'prompt_text').trim(),
            maxChars,
            originalChars,
            finalChars: text.length,
            overBudget: text.length > maxChars,
            trimmedSections,
            trimPolicy: 'low_priority_sections_only'
        };
        if (diagnostics.overBudget && options.blockOnOverBudget === true) {
            const largest = this._findLargestPromptSections(text).slice(0, 5);
            return {
                text: [
                    '# ERROR: PROMPT_CONTEXT_BUDGET_EXCEEDED',
                    '',
                    `label: ${diagnostics.label}`,
                    `maxChars: ${diagnostics.maxChars}`,
                    `finalChars: ${diagnostics.finalChars}`,
                    `trimmedSections: ${trimmedSections.length > 0 ? trimmedSections.join('、') : '无'}`,
                    '',
                    '当前 prompt 在裁剪低优先级块后仍超出预算。请继续瘦身 mustRead 指向的大文件或改为读取 compact/摘要，禁止继续生成污染上下文。',
                    '',
                    '## largestSections',
                    ...largest.map(item => `- ${item.heading}: ${item.chars} chars`)
                ].join('\n'),
                diagnostics: {
                    ...diagnostics,
                    blocked: true,
                    largestSections: largest
                }
            };
        }
        if (trimmedSections.length > 0 || options.alwaysAppendDiagnostics === true) {
            text = `${text.trimEnd()}\n\n## Prompt Budget Diagnostics\n- label: ${diagnostics.label}\n- originalChars: ${diagnostics.originalChars}\n- finalChars: ${diagnostics.finalChars}\n- maxChars: ${diagnostics.maxChars}\n- trimmedSections: ${trimmedSections.length > 0 ? trimmedSections.join('、') : '无'}\n`;
        }
        return { text, diagnostics };
    }

    _measureChars(value) {
        if (typeof value === 'string') return value.length;
        try {
            return JSON.stringify(value || '').length;
        } catch (_) {
            return String(value || '').length;
        }
    }

    _isOmitted(value) {
        if (typeof value === 'string') return /^\[(?:compact|budget)-omitted:[^\]]+\]$/.test(value);
        if (!value || typeof value !== 'object') return false;
        return Object.keys(value).some(key => this._isOmitted(value[key]));
    }

    _buildReason(name, value, priority) {
        if (this._isOmitted(value)) {
            return 'snapshot_compaction_omitted_large_or_regenerable_content';
        }
        if (priority === 'strong') return 'strong_contract_or_validation_context';
        if (priority === 'stage-critical') return 'current_stage_required_context';
        if (priority === 'context') return 'project_or_business_context';
        return `diagnostic_context:${name}`;
    }

    _replacePromptSection(text, heading, replacementBody) {
        const lines = String(text || '').split('\n');
        const target = String(heading || '').trim();
        const start = lines.findIndex(line => line.trim() === target);
        if (start === -1) return { text, changed: false };
        let end = lines.length;
        for (let index = start + 1; index < lines.length; index += 1) {
            if (/^##\s+/.test(lines[index])) {
                end = index;
                break;
            }
        }
        const replacement = [lines[start], String(replacementBody || '').trim()];
        return {
            text: [
                lines.slice(0, start).join('\n').trimEnd(),
                replacement.join('\n'),
                lines.slice(end).join('\n').trimStart()
            ].filter(Boolean).join('\n\n'),
            changed: true
        };
    }

    _findLargestPromptSections(text = '') {
        const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
        const sections = [];
        let current = { heading: '(preamble)', body: [] };
        for (const line of lines) {
            if (/^#{1,3}\s+/.test(line)) {
                sections.push(current);
                current = { heading: line.trim(), body: [line] };
            } else {
                current.body.push(line);
            }
        }
        sections.push(current);
        return sections
            .map(item => ({ heading: item.heading, chars: item.body.join('\n').length }))
            .filter(item => item.chars > 0)
            .sort((left, right) => right.chars - left.chars);
    }
}

module.exports = PromptContextBudget;
