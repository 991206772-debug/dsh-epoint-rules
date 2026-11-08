/* eslint-disable */
const crypto = require('crypto');
const fs = require('fs');

/**
 * 规则摘要服务
 * 职责：
 *   - 从规则正文中提取结构化摘要（核心约束、正例/反例、可门禁检查项）
 *   - 替代直接 slice(0, 1600) 截断，避免后段硬约束丢失
 *   - 生成 digestHash 用于 prompt diagnostics 和回归校验
 *
 * 禁止：
 *   - 不搜索工程源码补规则
 *   - 不猜测规则内容
 *   - 不静默丢弃无法解析的规则
 */

const CONSTRAINT_PATTERNS = [
    /必须[：:]?\s*(.+)/gi,
    /禁止[：:]?\s*(.+)/gi,
    /只允许[：:]?\s*(.+)/gi,
    /不得[：:]?\s*(.+)/gi,
    /违反即阻断[：:]?\s*(.+)/gi,
    /严禁[：:]?\s*(.+)/gi,
    /强制要求[：:]?\s*(.+)/gi,
    /硬门禁[：:]?\s*(.+)/gi
];

const EXAMPLE_PATTERNS = [
    /```[\s\S]*?```/g,
    /正例[：:]?\s*(.+)/gi,
    /反例[：:]?\s*(.+)/gi,
    /模板[：:]?\s*(.+)/gi,
    /样例[：:]?\s*(.+)/gi,
    /示例[：:]?\s*(.+)/gi
];

const CHECKLIST_PATTERNS = [
    /- \[.\]\s*(.+)/gi,
    /checklist[：:]?\s*(.+)/gi,
    /检查项[：:]?\s*(.+)/gi,
    /验收标准[：:]?\s*(.+)/gi,
    /门禁条件[：:]?\s*(.+)/gi
];

function sha256(text) {
    return crypto.createHash('sha256').update(String(text || ''), 'utf-8').digest('hex');
}

function extractLinesByPatterns(content, patterns) {
    const lines = [];
    for (const pattern of patterns) {
        const regex = new RegExp(pattern.source, pattern.flags);
        let match;
        while ((match = regex.exec(content)) !== null) {
            const line = String(match[0] || '').trim();
            if (line && line.length > 3 && !lines.some(existing => existing.includes(line) || line.includes(existing))) {
                lines.push(line.length > 300 ? line.slice(0, 300) + '…' : line);
            }
            if (lines.length >= 20) break;
        }
        if (lines.length >= 20) break;
    }
    return lines;
}

function extractCodeBlocks(content) {
    const blocks = [];
    const regex = /```(\w*)\n([\s\S]*?)```/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
        const lang = String(match[1] || '').trim();
        const code = String(match[2] || '').trim();
        if (code.length > 10) {
            blocks.push({
                lang,
                snippet: code.length > 400 ? code.slice(0, 400) + '\n// …（截断）' : code
            });
        }
        if (blocks.length >= 8) break;
    }
    return blocks;
}

function buildRuleDigest(ruleContent, options = {}) {
    const content = String(ruleContent || '').trim();
    if (!content) {
        return {
            ok: false,
            code: 'RULE_CONTENT_MISSING',
            coreConstraints: [],
            examples: [],
            requiredChecks: [],
            fullPath: options.fullPath || '',
            ruleName: options.ruleName || '',
            digestHash: '',
            diagnostics: '规则内容为空'
        };
    }

    const coreConstraints = extractLinesByPatterns(content, CONSTRAINT_PATTERNS);
    const codeBlocks = extractCodeBlocks(content);
    const requiredChecks = extractLinesByPatterns(content, CHECKLIST_PATTERNS);

    const examples = codeBlocks.map(b => `[${b.lang || 'code'}] ${b.snippet}`);

    const digestBody = [
        `ruleName: ${options.ruleName || ''}`,
        `coreConstraints: ${coreConstraints.join('; ')}`,
        `examplesCount: ${examples.length}`,
        `requiredChecks: ${requiredChecks.join('; ')}`
    ].join('\n');

    const digestHash = sha256(digestBody);

    return {
        ok: true,
        code: 'RULE_DIGEST_OK',
        coreConstraints,
        examples,
        requiredChecks,
        fullPath: options.fullPath || '',
        ruleName: options.ruleName || '',
        digestHash,
        diagnostics: `constraints=${coreConstraints.length}, examples=${examples.length}, checks=${requiredChecks.length}, chars=${content.length}`
    };
}

function buildRuleDigestBlock(ruleContent, options = {}) {
    const digest = buildRuleDigest(ruleContent, options);
    if (!digest.ok) {
        return {
            block: `### [规则摘要缺失] ${options.ruleName || '未知规则'}\n- 错误码: ${digest.code}\n- 路径: ${digest.fullPath || '未知'}\n`,
            digest
        };
    }

    const lines = [
        `### [规则摘要] ${digest.ruleName}`,
        `- 路径: ${digest.fullPath || '内置规则'}`,
        `- digestHash: ${digest.digestHash}`,
        `- 诊断: ${digest.diagnostics}`
    ];

    if (digest.coreConstraints.length > 0) {
        lines.push('- 核心约束:');
        digest.coreConstraints.forEach(c => lines.push(`  - ${c}`));
    }

    if (digest.examples.length > 0) {
        lines.push('- 关键示例/模板:');
        digest.examples.slice(0, 4).forEach(e => {
            const short = e.length > 300 ? e.slice(0, 300) + '…' : e;
            lines.push(`  - ${short}`);
        });
    }

    if (digest.requiredChecks.length > 0) {
        lines.push('- 可门禁检查项:');
        digest.requiredChecks.slice(0, 6).forEach(c => lines.push(`  - ${c}`));
    }

    lines.push('');
    return {
        block: lines.join('\n'),
        digest
    };
}

/**
 * 批量构建规则摘要上下文
 * @param {Array} rules - 规则对象数组 { name, path, content }
 * @returns {object} { block, digests, missing }
 */
function buildMultiRuleDigestBlock(rules = []) {
    const digests = [];
    const missing = [];
    const blocks = [];

    for (const rule of rules) {
        const name = String(rule && (rule.ruleAlias || rule.name || rule.id) || '').trim();
        const content = String(rule && rule.content || '').trim();
        const fullPath = String(rule && rule.path || '').trim();

        if (!content) {
            missing.push({ ruleName: name, fullPath, code: 'RULE_CONTENT_MISSING' });
            continue;
        }

        const result = buildRuleDigestBlock(content, { ruleName: name, fullPath });
        blocks.push(result.block);
        digests.push(result.digest);
    }

    return {
        block: blocks.join('\n'),
        digests,
        missing: missing.length > 0 ? missing : [],
        ok: missing.length === 0
    };
}

/**
 * Prompt 占位符校验
 * 命中未解析占位符时返回明确错误码
 */
function assertPromptNoUnresolvedPlaceholders(promptText, label = 'prompt') {
    const text = String(promptText || '');
    const unresolvedPatterns = [
        { pattern: /\$\{[^}]*\}/g, name: '${...}' },
        { pattern: /\{\{TBD\}\}/gi, name: '{{TBD}}' },
        { pattern: /\{\{[^}]*待[^}]*\}\}/gi, name: '{{待...}}' },
        { pattern: /<待[^>]*>/gi, name: '<待...>' },
        { pattern: /\{\{[^}]*?\}\}/g, name: '{{...}}' }
    ];

    const hits = [];
    for (const { pattern, name } of unresolvedPatterns) {
        const matches = text.match(pattern);
        if (matches) {
            for (const match of matches) {
                hits.push({ placeholder: match, patternName: name });
            }
        }
    }

    if (hits.length > 0) {
        const uniqueHits = hits.slice(0, 10);
        return {
            ok: false,
            code: 'PROMPT_UNRESOLVED_PLACEHOLDERS',
            label,
            message: `【${label}】存在未解析占位符: ${uniqueHits.map(h => `${h.patternName}(${h.placeholder})`).join('、')}`,
            hits: uniqueHits
        };
    }

    return { ok: true, code: 'PROMPT_PLACEHOLDERS_OK', label };
}

module.exports = {
    buildRuleDigest,
    buildRuleDigestBlock,
    buildMultiRuleDigestBlock,
    assertPromptNoUnresolvedPlaceholders,
    sha256
};
