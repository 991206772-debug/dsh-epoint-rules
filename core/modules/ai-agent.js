const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const yaml = require('js-yaml');
const CompatibilityHandler = require('./compatibility-handler');
const SecurityHandler = require('./security-handler');

class AIAgent {
    constructor(ruleService, skillIntentService) {
        this.ruleService = ruleService;
        this.skillIntentService = skillIntentService;

        // 初始化专项场景处理器
        this.compatibilityHandler = new CompatibilityHandler(ruleService);
        this.securityHandler = new SecurityHandler(ruleService);
    }

    // 发现规则 (供专项审计使用)
    discoverRulesFromIntent(userIntent) {
        const result = this.skillIntentService.intentRecognize(userIntent);
        if (result && result._structured && result._structured.matched) {
            const primary = result._structured.primary_skill;
            // 重要：将规则正文内容附着到 rule 对象上，以便后续处理器提取关键字
            if (result._structured.rule_content) {
                primary.content = result._structured.rule_content;
            }
            return {
                matched: true,
                primary: primary,
                allMatches: result._structured.all_matches || [primary],
                text: result.text
            };
        }
        return { matched: false, rules: [], text: result ? result.text : '' };
    }

    async performBatchAudit(projectPath, userIntent, phase, matchedRules) {
        const allMatches = matchedRules.allMatches || [matchedRules.primary];
        let aggregatedConfig = { rules: [] };

        for (const rule of allMatches) {
            const config = rule.audit_config || {};
            const content = rule.content || '';

            // 提取规则
            let currentRules = config.rules || [];
            if (currentRules.length === 0) {
                currentRules = this.extractRulesFromMDC(content);
            }

            // 特殊兼容性处理：如果是国产化适配且规则库是外部 YAML
            if (rule.id.includes('国产化适配') && !currentRules.length) {
                const dialects = this.compatibilityHandler.resolveDialects(userIntent, content);
                if (dialects.source && dialects.target) {
                    const yamlPath = path.join(projectPath, `projectrules/规则库/数据库/${dialects.source}_to_${dialects.target}.yaml`);
                    if (fs.existsSync(yamlPath)) {
                        currentRules = this.loadRulesFromYaml(yamlPath);
                    }
                }
            }

            aggregatedConfig.rules = aggregatedConfig.rules.concat(currentRules);
            // 合并其他配置项 (如 output_file, 只要有一个设置了就用它，或者默认)
            if (config.output_file) aggregatedConfig.output_file = config.output_file;
        }

        const config = aggregatedConfig;

        // 3. 构建临时配置文件
        const tempConfigPath = path.join(projectPath, `.tmp_audit_config_${Date.now()}.json`);
        fs.writeFileSync(tempConfigPath, JSON.stringify(config, null, 2), 'utf-8');

        // 4. 执行通用审计脚本
        let scriptPath = path.join(__dirname, '..', 'mcp_tools', 'scripts', 'fast_audit.py');
        if (!fs.existsSync(scriptPath)) {
            // 兼容开发环境
            scriptPath = path.join(__dirname, '..', 'scripts', 'fast_audit.py');
        }
        if (!fs.existsSync(scriptPath)) {
            // 兼容 Trae 扩展目录结构
            scriptPath = path.join(__dirname, 'scripts', 'fast_audit.py');
        }
        const outputFileName = phase === 'verify' ? (config.verify_file || '审计验证报表.md') : (config.output_file || '代码审计清单.md');
        const outputPath = path.join(projectPath, outputFileName);

        const verifyFlag = phase === 'verify' ? ' --verify' : '';
        const cmd = `python "${scriptPath}" --project "${projectPath}" --output "${outputPath}" --config "${tempConfigPath}"${verifyFlag}`;

        console.error(`[AIAgent] Executing Global Audit: ${cmd}`);
        let result = `## 🏭 通用审计工厂 (Audit Factory)\n\n`;

        try {
            const output = execSync(cmd, { encoding: 'utf-8', stdio: 'pipe' });
            console.error(`[AIAgent] Script Output: ${output}`);
            if (fs.existsSync(outputPath)) {
                result += fs.readFileSync(outputPath, 'utf-8');
            } else {
                result += `❌ 未能生成报表文件。`;
            }
        } catch (e) {
            console.error(`[AIAgent] Execution error: ${e.stderr || e.message}`);
            result += `❌ 审计引擎执行失败: ${e.message}`;
        } finally {
            if (fs.existsSync(tempConfigPath)) fs.unlinkSync(tempConfigPath);
        }

        return result;
    }

    // 辅助方法：从 MDC 中智能提取审计规则
    extractRulesFromMDC(content) {
        const rules = [];
        // 匹配表格行，提取 [pattern, desc, suggestion]
        const tableLines = content.split('\n').filter(l => l.includes('|') && !l.includes('---'));
        for (const line of tableLines) {
            const cells = line.split('|').map(c => c.trim()).filter(Boolean);
            if (cells.length >= 3) {
                let rawPattern = '';
                let desc = '';
                let suggestion = '';

                if (cells[1].includes('`')) {
                    // 情况1: 包含反引号的代码或关键词列表
                    rawPattern = cells[1];
                    desc = cells[0].replace(/\*/g, ''); // 去除加粗
                    suggestion = cells[2];
                } else if (cells[2] && cells[2].length > 1 && (cells[2].includes('`') || cells[2].includes('\\'))) {
                    // 情况2: 第二列是说明，第三列是正则代码
                    desc = cells[1];
                    rawPattern = cells[2];
                    suggestion = cells[3] || '';
                }

                if (rawPattern) {
                    // 处理反引号：`name`, `phone` -> (name|phone)
                    let pattern = rawPattern.replace(/`/g, '');
                    if (pattern.includes(',')) {
                        const parts = pattern.split(',').map(p => p.trim()).filter(Boolean);
                        pattern = `(${parts.join('|')})`;
                    }

                    if (pattern && pattern.length > 1) {
                        rules.push({ pattern, desc, suggestion });
                    }
                }
            }
        }
        return rules;
    }

    // 辅助方法 (Handler 们会调用)
    loadRulesFromYaml(filePath) {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            return yaml.load(content);
        } catch (e) {
            console.error('Failed to load YAML:', e);
            return [];
        }
    }

    parseListRequirements(content) {
        const section = this.extractSection(content, /清单要求/);
        if (!section) return null;
        const fileMatch = section.match(/`([^`]+\.md)`/);
        const fileName = fileMatch ? fileMatch[1] : '排查清单.md';
        return { fileName };
    }

    extractSection(content, regex) {
        if (!content) return null;
        const lines = content.split('\n');
        let startIndex = -1;
        for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
                startIndex = i;
                break;
            }
        }
        if (startIndex === -1) return null;
        let result = [];
        for (let i = startIndex; i < lines.length; i++) {
            const line = lines[i];
            if (i > startIndex && /^#+ /.test(line)) break;
            result.push(line);
        }
        return result.join('\n').trim();
    }

    extractSensitiveKeywords(content) {
        const keywords = [];
        if (!content) {
            console.error(`[AIAgent] extractSensitiveKeywords: No content provided`);
            return keywords;
        }

        console.error(`[AIAgent] extractSensitiveKeywords: Content length: ${content.length}`);

        // 1. 优先从表格提取 (常见于标准 MDC)
        // 匹配格式: | 敏感项 | `name`, `phone` | ... |
        const tableLines = content.split('\n').filter(l => l.includes('|'));
        console.error(`[AIAgent] Found ${tableLines.length} potential table lines`);

        for (const line of tableLines) {
            const cells = line.split('|').map(c => c.trim()).filter(Boolean);
            if (cells.length >= 2) {
                const name = cells[0].replace(/\*/g, ''); // 移除粗体
                const patternCell = cells[1];

                // 提取反引号中的词: `name`, `phone` -> name|phone
                const codeBlocks = patternCell.match(/`([^`]+)`/g);
                if (codeBlocks) {
                    const pattern = codeBlocks.map(b => b.replace(/`/g, '')).join('|');
                    console.error(`[AIAgent] Extracted from table: ${name} -> ${pattern}`);
                    keywords.push({ name, pattern });
                }
            }
        }

        // 2. 如果表格没搜到，尝试从列表提取 (Legacy 兼容)
        if (keywords.length === 0) {
            console.error('[AIAgent] No keywords from table, trying list format...');
            const regex = /-\s*(.+?):\s*(.+)/g;
            let match;
            while ((match = regex.exec(content)) !== null) {
                console.error(`[AIAgent] Extracted from list: ${match[1]} -> ${match[2]}`);
                keywords.push({ name: match[1].trim(), pattern: match[2].trim() });
            }
        }

        console.error(`[AIAgent] Total keywords extracted: ${keywords.length}`);
        return keywords;
    }
}

module.exports = AIAgent;
