const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * 安全整改/脱敏场景处理器
 */
class SecurityHandler {
    constructor(ruleService) {
        this.ruleService = ruleService;
    }

    /**
     * 执行扫描报告逻辑
     */
    async handleScan(agent, projectPath, userIntent, requirements, matchedRules, skipWorkflow = false) {
        let result = `## 🚀 极速审计中 (Security Engine)\n\n`;
        const primaryRule = matchedRules.primary;
        const ruleContent = primaryRule.content || '';

        // 1. 深度扫描逻辑 (MDC Driven)
        if (primaryRule.actions && (primaryRule.actions.includes('DEEP_SCAN') || primaryRule.actions.some(a => a.name === 'DEEP_SCAN'))) {
            // 动态从 MDC 正文中提取执行命令 (匹配 ### 步骤 1: DEEP_SCAN 或类似标题下的 bash 块)
            const executionBlockRegex = /### .*?步骤 1: DEEP_SCAN[\s\S]*?```bash\n([\s\S]*?)\n```/i;
            const match = executionBlockRegex.exec(ruleContent);

            if (match && match[1]) {
                let cmdTemplate = match[1].trim();
                const scriptAbsPath = fs.existsSync(path.join(__dirname, '..', 'scripts', 'fast_audit.py'))
                    ? path.join(__dirname, '..', 'scripts', 'fast_audit.py')
                    : path.join(__dirname, '..', 'mcp_tools', 'scripts', 'fast_audit.py');

                // 替换路径占位符
                cmdTemplate = cmdTemplate.replace('python mcp_tools/scripts/fast_audit.py', `python "${scriptAbsPath}"`);
                cmdTemplate = cmdTemplate.replace('mcp_tools/scripts/fast_audit.py', `"${scriptAbsPath}"`);

                // 提取配置路径
                const configMatch = /--config\s+"([^"]+)"/.exec(cmdTemplate);
                if (configMatch) {
                    const relativeConfig = configMatch[1];
                    let absConfig = path.join(projectPath, relativeConfig);
                    if (process.platform === 'win32') absConfig = absConfig.replace(/\\/g, '/');

                    // 智能补全规则文件 (如果 YAML 存在则转 JSON)
                    if (absConfig.endsWith('.yaml') && fs.existsSync(absConfig)) {
                        const yamlContent = agent.loadRulesFromYaml(absConfig);
                        const jsonConfigPath = absConfig.replace('.yaml', '.json');
                        fs.writeFileSync(jsonConfigPath, JSON.stringify(yamlContent, null, 2), 'utf-8');
                        cmdTemplate = cmdTemplate.replace(relativeConfig, relativeConfig.replace('.yaml', '.json'));
                    }
                }

                try {
                    execSync(cmdTemplate, { encoding: 'utf-8', stdio: 'pipe' });
                    const outputPathMatch = /--output\s+"([^"]+)"/.exec(cmdTemplate);
                    if (outputPathMatch && fs.existsSync(path.join(projectPath, outputPathMatch[1]))) {
                        result += fs.readFileSync(path.join(projectPath, outputPathMatch[1]), 'utf-8') + `\n\n`;
                    }
                    result += `> [!SUCCESS]\n> **深度扫描完成**：已根据 MDC 协议成功执行。\n\n`;
                    // 添加强制停止信号
                    result += `---\n\n`;
                    result += `## 🛑 [STOP] 请停止执行\n\n`;
                    result += `> [!IMPORTANT]\n`;
                    result += `> **扫描清单已生成完毕**。请将上述内容完整呈现给用户查阅。\n`;
                    result += `> **严禁继续执行任何其他操作**。请等待用户确认。`;
                } catch (e) {
                    throw new Error(`执行审计命令失败: ${e.message}`);
                }
            }
        }
        // 2. 传统脱敏逻辑兼容 (Legacy)
        else if (userIntent.includes('脱敏') || primaryRule.name.includes('脱敏')) {
            const keywords = agent.extractSensitiveKeywords(ruleContent);
            const configPath = path.join(projectPath, 'audit_config.json');
            fs.writeFileSync(configPath, JSON.stringify(keywords, null, 2), 'utf-8');

            const scriptPath = fs.existsSync(path.join(__dirname, '..', 'scripts', 'fast_audit.py'))
                ? path.join(__dirname, '..', 'scripts', 'fast_audit.py')
                : path.join(__dirname, '..', 'mcp_tools', 'scripts', 'fast_audit.py');
            const listRequirements = agent.parseListRequirements(ruleContent);
            const listFileName = listRequirements ? listRequirements.fileName : '脱敏现状排查清单.md';
            const outputPath = path.join(projectPath, listFileName);

            const cmd = `python "${scriptPath}" --project "${projectPath}" --output "${outputPath}" --config "${configPath}"`;
            console.error(`[SecurityHandler] Executing: ${cmd}`);
            console.error(`[SecurityHandler] Keywords found: ${JSON.stringify(keywords)}`);

            try {
                const output = execSync(cmd, { encoding: 'utf-8', stdio: 'pipe' });
                console.error(`[SecurityHandler] Script Output: ${output}`);
            } catch (e) {
                console.error(`[SecurityHandler] Execution error: ${e.stderr || e.message}`);
                // Don't throw here, let it try to read the file if generated
            }

            if (fs.existsSync(outputPath)) {
                result += fs.readFileSync(outputPath, 'utf-8') + `\n\n`;
                // 添加强制停止信号
                result += `\n\n---\n\n`;
                result += `## 🛑 [STOP] 请停止执行\n\n`;
                result += `> [!IMPORTANT]\n`;
                result += `> **脱敏排查清单已生成完毕**。请将上述内容完整呈现给用户查阅。\n`;
                result += `> **严禁继续执行任何其他操作**（如搜索文件、读取代码、调用其他工具）。\n`;
                result += `> 请等待用户确认后再继续下一步。\n\n`;
                result += `**下一步操作**：用户确认后，可以逐个修改上述文件引入脱敏组件。`;
            } else {
                result += `\n> [!CAUTION]\n> 未能生成审计报表文件。请检查控制台日志获取详细错误信息。`;
            }
        }

        return result;
    }
}

module.exports = SecurityHandler;
