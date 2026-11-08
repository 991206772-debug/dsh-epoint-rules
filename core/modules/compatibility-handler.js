const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

/**
 * 国产化适配场景处理器
 */
class CompatibilityHandler {
    constructor(ruleService) {
        this.ruleService = ruleService;
    }

    /**
     * 解析方言
     */
    resolveDialects(userIntent, ruleContent) {
        const userInput = userIntent.toLowerCase();
        // 修正：更加宽泛地匹配 PREPARE 章节，不仅限于“步骤 0”
        const prepSection = this.extractSection(ruleContent, /PREPARE/i);
        let dialectMap = { source: {}, target: {} };

        if (prepSection) {
            console.error('[CompatibilityHandler] 找到 PREPARE 章节，长度:', prepSection.length);
            try {
                const codeBlockMatch = prepSection.match(/```yaml\r?\n([\s\S]+?)\r?\n```/);
                if (codeBlockMatch) {
                    console.error('[CompatibilityHandler] 找到 YAML 块');
                    const config = yaml.load(codeBlockMatch[1]);
                    console.error('[CompatibilityHandler] YAML 解析结果:', JSON.stringify(config, null, 2));
                    // 处理两种 YAML 格式：
                    // 1. dialects 作为顶层: {dialects: {...}, prompt: ...}
                    // 2. source/target 作为顶层: {source: {...}, target: {...}, prompt: ...}
                    if (config.dialects) {
                        dialectMap = config.dialects;
                        console.error('[CompatibilityHandler] 使用 config.dialects');
                    } else if (config.source || config.target) {
                        dialectMap = {
                            source: config.source || {},
                            target: config.target || {}
                        };
                        console.error('[CompatibilityHandler] 使用顶层 source/target');
                    } else {
                        console.error('[CompatibilityHandler] 无法识别 YAML 格式');
                    }
                    console.error('[CompatibilityHandler] 最终 dialectMap:', JSON.stringify(dialectMap, null, 2));
                } else {
                    console.error('[CompatibilityHandler] 未找到 YAML 块');
                }
            } catch (e) {
                console.error('[CompatibilityHandler] YAML解析错误:', e.message);
            }
        } else {
            console.error('[CompatibilityHandler] 未找到 PREPARE 章节');
        }

        const matchDialect = (input, map) => {
            for (const [key, keywords] of Object.entries(map)) {
                if (keywords.some(k => input.includes(k))) return key;
            }
            return null;
        };

        return {
            source: matchDialect(userInput, dialectMap.source),
            target: matchDialect(userInput, dialectMap.target)
        };
    }

    // 辅助方法 - 提取指定章节
    extractSection(content, regex) {
        if (!content) return null;

        // 使用正则匹配整个章节（包括 YAML 块）
        const sectionMatch = content.match(new RegExp(
            '(' + regex.source + '[^]*?)(?=\n#+ [^]|---)',
            regex.flags
        ));

        if (sectionMatch) {
            return sectionMatch[1].trim();
        }
        return null;
    }

    /**
     * 执行国产化适配工作流
     */
    async handle(agent, projectPath, userIntent, requirements, matchedRules, phase = 'audit') {
        const userInput = userIntent.toLowerCase();
        const primaryRule = matchedRules.primary;
        const ruleContent = primaryRule ? primaryRule.content : '';

        // 1. 自动识别方言
        const dialects = this.resolveDialects(userIntent, ruleContent);
        let promptText = `# 🚀 国产化适配助手\n\n为了精准选择规则库，请先确认环境信息。`;

        // 如果 MDC 中定义了特殊的 prompt，提取出来用于追问
        const prepSectionStrict = this.extractSection(ruleContent, /PREPARE/i);
        if (prepSectionStrict) {
            try {
                const codeBlockMatch = prepSectionStrict.match(/```yaml\r?\n([\s\S]+?)\r?\n```/);
                if (codeBlockMatch) {
                    const config = yaml.load(codeBlockMatch[1]);
                    if (config.prompt) promptText = `# 🚀 国产化适配助手\n\n${config.prompt}`;
                }
            } catch (e) { }
        }
        if (!dialects.source || !dialects.target) {
            // 只有当完全无法识别方言时，才进行极简追问
            return `[WAITING_FOR_USER_INPUT]\n\n${promptText}\n\n> [!TIP]\n> 您可以这样回复：**“从 Oracle 转到 PostgreSQL”**。`;
        }

        const sourceDialect = dialects.source;
        const targetDialect = dialects.target;

        // 3. 映射逻辑 - 动态发现规则库位置
        const configFilename = `${sourceDialect}_to_${targetDialect}.yaml`;

        // 策略：基于 RuleService 已经扫描到的所有规则目录进行动态搜索
        // 这样可以确保我们寻找 YAML 的目录正是 RuleService 认可的规则资产目录
        const findConfigPath = () => {
            const roots = new Set();
            // 1. 基础根目录
            roots.add(agent.ruleService.rulesPath);
            if (agent.ruleService.userRulesPath) roots.add(agent.ruleService.userRulesPath);

            // 2. 从已加载的规则中推导所有仓库根目录
            agent.ruleService.listRules().forEach(r => {
                let dir = path.dirname(r.path);
                // 向上找，直到到达 rulesPath，寻找包含“规则库”的父目录
                while (dir && dir.length >= agent.ruleService.rulesPath.length) {
                    roots.add(dir);
                    dir = path.dirname(dir);
                }
            });

            for (const root of roots) {
                const tryPaths = [
                    path.join(root, '规则库/数据库', configFilename),
                    path.join(root, '数据库', configFilename), // 如果已经在规则库目录下
                    path.join(root, configFilename)            // 允许直接放在目录下
                ];
                for (const p of tryPaths) {
                    if (fs.existsSync(p)) return p;
                }
            }
            return null;
        };

        let configPath = findConfigPath();

        let result = `# 🚀 国产化适配启动：${sourceDialect.toUpperCase()} -> ${targetDialect.toUpperCase()}\n\n`;

        if (fs.existsSync(configPath)) {
            result += `> [!SUCCESS]\n> 已自动匹配到规则库：\`${configFilename}\`。\n\n`;

            // 1. 将 YAML 转换为 JSON (fast_audit.py 目前仅支持 JSON)
            const tempConfigPath = path.join(projectPath, `.tmp_audit_comp_${Date.now()}.json`);
            try {
                const yamlContent = fs.readFileSync(configPath, 'utf-8');
                const jsonRules = yaml.load(yamlContent);
                // 注入元数据供报表生成使用
                jsonRules.sourceDB = jsonRules.sourceDB || sourceDialect;
                jsonRules.targetDB = jsonRules.targetDB || targetDialect;
                jsonRules.report_title = `国产化适配排查清单 (${jsonRules.sourceDB} -> ${jsonRules.targetDB})`;

                fs.writeFileSync(tempConfigPath, JSON.stringify(jsonRules, null, 2), 'utf-8');
            } catch (e) {
                return `❌ 转换规则库失败: ${e.message}`;
            }

            // 2. 准备执行命令
            const scriptPath = fs.existsSync(path.join(__dirname, '..', 'scripts', 'fast_audit.py'))
                ? path.join(__dirname, '..', 'scripts', 'fast_audit.py')
                : path.join(__dirname, '..', 'mcp_tools', 'scripts', 'fast_audit.py');

            const listFileName = phase === 'verify' ? '国产化整改验证报表.md' : '国产化适配排查清单.md';
            const outputPath = path.join(projectPath, listFileName);

            const args = [scriptPath, '--project', projectPath, '--output', outputPath, '--config', tempConfigPath];
            if (phase === 'verify') args.push('--verify');

            console.error(`[CompatibilityHandler] Executing: python ${args.join(' ')}`);

            try {
                // 使用 execFileSync 避免 shell 转义问题
                console.error(`[CompatibilityHandler] Running python with args: ${args.join(', ')}`);
                const output = require('child_process').execFileSync('python', args, { encoding: 'utf-8', stdio: 'pipe' });
                console.error(`[CompatibilityHandler] Script STDOUT: ${output}`);
            } catch (e) {
                console.error(`[CompatibilityHandler] Execution ERROR: ${e.message}`);
                if (e.stdout) console.error(`[CompatibilityHandler] Partial STDOUT: ${e.stdout}`);
                if (e.stderr) console.error(`[CompatibilityHandler] STDERR: ${e.stderr}`);
                return `❌ 执行审计脚本失败: ${e.message}\n${e.stderr || ''}`;
            } finally {
                if (fs.existsSync(tempConfigPath)) {
                    console.error(`[CompatibilityHandler] Deleting temp config: ${tempConfigPath}`);
                    fs.unlinkSync(tempConfigPath);
                }
            }

            if (fs.existsSync(outputPath)) {
                result += fs.readFileSync(outputPath, 'utf-8') + `\n\n`;
                if (phase === 'verify') {
                    result += `> [!SUCCESS]\n> **整改验证完成**：已生成每个改动点对应的 SQL 验证清单，请在数据库执行校验。`;
                } else {
                    // 审计阶段：添加强制停止信号
                    result += `\n\n---\n\n`;
                    result += `## 🛑 [STOP] 请停止执行\n\n`;
                    result += `> [!IMPORTANT]\n`;
                    result += `> **清单已生成完毕**。请将上述内容完整呈现给用户查阅。\n`;
                    result += `> **严禁继续执行任何其他操作**（如搜索文件、读取代码、调用其他工具）。\n`;
                    result += `> 请等待用户确认后再继续下一步。\n\n`;
                    result += `**下一步操作**：用户确认后，请调用 \`compatibility_audit_task\` 并设置 \`phase: "verify"\` 进行整改验证。`;
                }
            } else {
                result += `\n> [!CAUTION]\n> 未能生成国产化报表文件。请检查控制台日志。`;
            }
            return result;
        } else {
            // 搜集所有可能路径下的可用规则
            const allAvailable = [];
            const checkDirs = [
                path.join(rulesBasePath, '规则库/数据库'),
                path.join(rulesBasePath, '.project_repo/projectrules/规则库/数据库'),
                path.join(rulesBasePath, '.product_repo/projectrules/规则库/数据库')
            ];

            checkDirs.forEach(dir => {
                if (fs.existsSync(dir)) {
                    const files = fs.readdirSync(dir).filter(f => f.endsWith('.yaml'));
                    allAvailable.push(...files);
                }
            });

            // 去重
            const available = [...new Set(allAvailable)];

            result += `> [!CAUTION]\n> 找不到对应的规则库：\`${configFilename}\`。\n\n`;
            if (available.length > 0) {
                result += `**探测到以下可用规则库**：\n`;
                available.forEach(f => result += `- \`${f}\`\n`);
                result += `\n您可以尝试明确指定方言，例如：**“从 Oracle 转到 PostgreSQL”**。`;
            } else {
                result += `请检查规范仓库的 \`规则库/数据库\` 目录是否正确下载到以下位置：\n`;
                result += `- \`${path.join(rulesBasePath, '.project_repo/projectrules/规则库/数据库')}\`\n`;
                result += `\n您可以尝试点击侧边栏的 **“检查规范更新”** 按钮。`;
            }
            return result;
        }
    }
}

module.exports = CompatibilityHandler;
