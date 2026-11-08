/* eslint-disable */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * 国产化适配专家 — 独立工作流模块
 * 
 * 使用独立的分阶段审计模式，管理国产化适配全流程：
 *   INIT → AUDITED → FIXING (循环) → VERIFIED
 * 
 * 每个阶段自动输出"下一步"引导，驱动用户持续操作。
 */
class LocalizationExpert {
    constructor(ruleService) {
        this.ruleService = ruleService;
    }

    // ========================
    // 主入口
    // ========================
    async execute(userIntent, projectPath, phase, targetFile) {
        const state = this._loadState(projectPath);
        const input = (userIntent || '').trim();

        // 重置指令
        if (input === 'reset' || input === '重置') {
            this._saveState(projectPath, { status: 'INIT', completed: [], excluded: [] });
            return '🔄 国产化适配流程已重置。请重新输入"国产化适配"开始。';
        }

        // 阶段路由
        if (phase === 'audit') {
            return await this.executeAudit(projectPath, input);
        }
        if (phase === 'fix') {
            const file = targetFile || this._extractFileName(input);
            if (!file) {
                return this._buildPickFileGuide(projectPath, state, '请指定要适配的文件名。');
            }
            return await this.executeFix(projectPath, file, state);
        }
        if (phase === 'verify') {
            return await this.executeVerify(projectPath, state);
        }

        // 默认：根据状态引导
        if (state.status === 'AUDITED' || state.status === 'FIXING') {
            const file = this._extractFileName(input);
            if (file) {
                return await this.executeFix(projectPath, file, state);
            }
            return this._buildPickFileGuide(projectPath, state);
        }

        return await this.executeAudit(projectPath, input);
    }

    // ========================
    // 阶段 1: 扫描审计
    // ========================
    async executeAudit(projectPath, userIntent) {
        // 1. 解析方言
        const dialects = this._resolveDialects(userIntent);
        if (!dialects.source || !dialects.target) {
            return `[WAITING_FOR_USER_INPUT]\n\n# 🚀 国产化适配专家\n\n为了精准选择规则库，请确认：\n\n> **您的源数据库和目标数据库分别是什么？**\n> 例如：\`从 Oracle 转到 PostgreSQL\``;
        }

        // 2. 查找 YAML 规则库
        const configFilename = `${dialects.source}_to_${dialects.target}.yaml`;
        const configPath = this._findRuleConfig(configFilename);
        if (!configPath) {
            const currentPath = (this.ruleService && this.ruleService.rulesPath) ? this.ruleService.rulesPath : '未配置路径';
            return `[WAITING_FOR_USER_INPUT]\n\n❌ **未找到规则库文件** \`${configFilename}\`。\n\n请确认您在插件设置中配置的规则根目录：\n\`${currentPath}\`\n及其子目录中存在此文件。\n\n> 💡 提示：这通常是因为您没有同步最新的规范，或者 MCP 配置信息未更新。`;
        }

        // 3. 转换 YAML → JSON 临时配置
        const yaml = require('js-yaml');
        let jsonRules;
        try {
            const yamlContent = fs.readFileSync(configPath, 'utf-8');
            jsonRules = yaml.load(yamlContent);
            jsonRules.sourceDB = jsonRules.sourceDB || dialects.source;
            jsonRules.targetDB = jsonRules.targetDB || dialects.target;
            jsonRules.report_title = `国产化适配排查清单 (${jsonRules.sourceDB} -> ${jsonRules.targetDB})`;
        } catch (e) {
            return `❌ 规则库解析失败: ${e.message}`;
        }

        // 4. 读取现有清单的已完成项（用于排除）
        const checklistPath = path.join(projectPath, '国产化适配排查清单.md');
        const existingStatus = this._parseChecklistStatus(checklistPath);
        const doneFiles = Object.keys(existingStatus).filter(f => existingStatus[f] !== ' ');

        // 注入排除列表
        if (doneFiles.length > 0) {
            jsonRules.exclude_files = doneFiles;
        }

        const tempConfigPath = path.join(projectPath, `.tmp_compat_config_${Date.now()}.json`);
        fs.writeFileSync(tempConfigPath, JSON.stringify(jsonRules, null, 2), 'utf-8');

        // 5. 执行 fast_audit.py
        const scriptPath = this._getScriptPath();
        const outputPath = checklistPath;

        try {
            const args = [scriptPath, '--project', projectPath, '--output', outputPath, '--config', tempConfigPath];
            console.error(`[LocalizationExpert] Executing: python ${args.join(' ')}`);
            execFileSync('python', args, { timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (e) {
            const stderr = e.stderr ? e.stderr.toString() : '';
            return `❌ 审计脚本执行失败: ${e.message}\n${stderr}`;
        } finally {
            try { fs.unlinkSync(tempConfigPath); } catch (_) { }
        }

        // 6. 解析生成的清单，统计待处理项
        const checklist = this._parseChecklistStatus(checklistPath);
        const pending = Object.keys(checklist).filter(f => checklist[f] === ' ');
        const done = Object.keys(checklist).filter(f => checklist[f] !== ' ');

        // 7. 保存状态
        this._saveState(projectPath, {
            status: 'AUDITED',
            sourceDB: dialects.source,
            targetDB: dialects.target,
            configPath: configPath,
            checklistPath: checklistPath,
            total: Object.keys(checklist).length,
            completed: done,
            excluded: [],
            pending: pending
        });

        // 8. 构建引导输出
        let result = `# ✅ 国产化适配扫描完成\n\n`;
        result += `> 模式: \`${dialects.source.toUpperCase()} → ${dialects.target.toUpperCase()}\`\n`;
        result += `> 清单文件: \`${checklistPath}\`\n\n`;
        result += `📊 **统计**：共 ${Object.keys(checklist).length} 个文件 | ${done.length} 个已处理 | **${pending.length} 个待处理**\n\n`;

        if (pending.length === 0) {
            result += `🎉 所有文件均已处理！输入"验证"进行最终检查。\n`;
        } else {
            result += this._buildPendingFileList(projectPath, pending);
            result += `\n---\n\n`;
            result += `## 🚀 下一步\n\n`;
            result += `> [!IMPORTANT]\n`;
            result += `> **[单步模式]** 请从上方列表中选择一个文件，回复文件名即可开始适配。\n`;
            result += `> 例如：调用 \`compatibility_audit_task(phase='fix', targetFile='${pending[0]}')\`\n\n`;
            result += `> **[自动连跑模式]** 如果你想让我自动连续处理这批文件，请回复：\n`;
            result += `> \`“开启自动连跑，从 ${pending[0]} 开始，连续处理前10个”\`，我会在每次改完后自己读清单请求下一个。\n`;
        }

        result += `\n\n---\n\n🛑 [STOP] 请将上述内容完整呈现给用户。`;
        return result;
    }

    // ========================
    // 阶段 2: 逐文件适配
    // ========================
    async executeFix(projectPath, targetFile, state) {
        const checklistPath = state.checklistPath || path.join(projectPath, '国产化适配排查清单.md');

        // 1. 从清单中提取该文件的风险点
        const fileRisks = this._extractFileRisks(checklistPath, targetFile);
        if (!fileRisks) {
            return `⚠️ 在清单中未找到文件 \`${targetFile}\` 的记录。请检查文件名是否正确。\n\n${this._buildPickFileGuide(projectPath, state, '请选择一个存在的文件名：')}`;
        }

        // 2. 加载 YAML 转换规则摘要
        const conversionTable = this._loadConversionTable(state.configPath);

        // 3. 构建适配 prompt
        let prompt = `# 🔧 国产化适配指令：\`${targetFile}\`\n\n`;

        // 3a. 文件路径
        if (fileRisks.fullPath) {
            prompt += `> 完整路径: \`${fileRisks.fullPath}\`\n\n`;
        }

        // 3b. 风险方法表格
        prompt += `## 📋 该文件的风险点（共 ${fileRisks.methods.length} 个方法）\n\n`;
        prompt += `| 方法 | 命中风险 | 建议转换 |\n`;
        prompt += `|:---|:---|:---|\n`;
        for (const m of fileRisks.methods) {
            const suggestion = this._getSuggestion(m.risks, conversionTable);
            prompt += `| \`${m.name}\` | ${m.risks} | ${suggestion} |\n`;
        }

        // 3c. 代码模板
        prompt += `\n## ⚙️ 代码修改要求\n\n`;
        prompt += `1. 使用 \`if (baseDao.isPostgresql()) { ... } else { ... }\` 分支隔离\n`;
        prompt += `2. \`else\` 分支保留原代码 **100% 不变**\n`;
        prompt += `3. 每个方法独立改造，禁止提取公共工具方法\n`;
        prompt += `4. 禁止修改原有的 SQL 语句\n\n`;
        prompt += `### 代码范例\n\`\`\`java\nif (baseDao.isPostgresql()) {\n    // 适配分支：PostgreSQL\n    sql = "select coalesce(name, '') from user";\n} else {\n    // 原生分支：Oracle (保持 100% 不变)\n    sql = "select nvl(name, '') from user";\n}\n\`\`\`\n\n`;

        // 3d. 强制后置动作
        prompt += `## 🛑 强制后置动作（完成代码修改后必须执行）\n\n`;
        prompt += `> [!CAUTION]\n`;
        prompt += `> **代码修改完成后，你必须立即执行以下操作，不得跳过：**\n\n`;
        prompt += `1. 打开文件 \`${checklistPath}\`\n`;
        prompt += `2. 在**总览区**找到 \`[ ]${targetFile}\`，改为 \`[√]${targetFile} (已适配)\`\n`;
        prompt += `3. 在**详细清单区**找到 \`- [ ] 📄 文件: \`${targetFile}\`\`，改为 \`- [√] 📄 文件: \`${targetFile}\`\`\n`;
        prompt += `4. 如果该文件经核实**无需整改**（误报），则标记为 \`[X]${targetFile} (无需整改)\`\n\n`;

        // 4. 更新状态
        const completed = [...(state.completed || []), targetFile];
        const pending = (state.pending || []).filter(f => f !== targetFile);

        this._saveState(projectPath, {
            ...state,
            status: 'FIXING',
            completed: completed,
            pending: pending,
            lastFixed: targetFile
        });

        // 5. 追加"下一步"引导
        prompt += `---\n\n`;
        prompt += `## 📊 适配进度\n\n`;
        prompt += `✅ 已完成: ${completed.length} | 📋 待处理: ${pending.length}\n\n`;

        if (pending.length === 0) {
            prompt += `🎉 **所有文件已处理完毕！**\n\n`;
            prompt += `> 请调用 \`compatibility_audit_task(phase='verify')\` 进行最终验证。\n`;
        } else {
            prompt += `## 🚀 继续适配\n\n`;
            prompt += `以下是剩余待处理文件：\n\n`;
            const showCount = Math.min(pending.length, 10);
            for (let i = 0; i < showCount; i++) {
                prompt += `${i + 1}. \`${pending[i]}\`\n`;
            }
            if (pending.length > showCount) {
                prompt += `... 还有 ${pending.length - showCount} 个文件\n`;
            }

            prompt += `\n> **单步模式**：请回复下一个文件名，或输入"验证"进行最终检查。\n`;
            prompt += `> **[NEW] 自动连跑模式**：如果用户之前授权了"批量/自动/直接继续"，请您**不要停下来等待用户回复**，在完成当前文件的修改和清单同步后，请**自主调用** \`compatibility_audit_task(phase='fix', targetFile='${pending[0]}')\` 直接开始下一个文件的适配！\n`;
        }

        return prompt;
    }

    // ========================
    // 阶段 3: 验证
    // ========================
    async executeVerify(projectPath, state) {
        const configPath = state.configPath;
        if (!configPath || !fs.existsSync(configPath)) {
            return `❌ 未找到规则配置，请先执行 audit 阶段。`;
        }

        // 1. 准备验证配置
        const yaml = require('js-yaml');
        const yamlContent = fs.readFileSync(configPath, 'utf-8');
        const jsonRules = yaml.load(yamlContent);
        jsonRules.is_verify = true;
        jsonRules.report_title = '国产化整改验证报表';

        const tempConfigPath = path.join(projectPath, `.tmp_verify_config_${Date.now()}.json`);
        fs.writeFileSync(tempConfigPath, JSON.stringify(jsonRules, null, 2), 'utf-8');

        // 2. 执行验证扫描
        const scriptPath = this._getScriptPath();
        const outputPath = path.join(projectPath, '国产化整改验证报表.md');

        try {
            const args = [scriptPath, '--project', projectPath, '--output', outputPath, '--config', tempConfigPath, '--verify'];
            execFileSync('python', args, { timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (e) {
            return `❌ 验证脚本执行失败: ${e.message}`;
        } finally {
            try { fs.unlinkSync(tempConfigPath); } catch (_) { }
        }

        // 3. 解析验证结果
        let verifyContent = '';
        if (fs.existsSync(outputPath)) {
            verifyContent = fs.readFileSync(outputPath, 'utf-8');
        }

        const hasIssues = verifyContent.includes('⚠️ 验证未通过') || verifyContent.includes('❌ 待整改');

        let result = `# 📋 国产化整改验证结果\n\n`;

        if (!hasIssues || verifyContent.includes('✅ 验证通过')) {
            result += `## ✅ 验证通过！\n\n`;
            result += `所有已适配的文件均已通过验证，未发现遗漏的兼容性问题。\n\n`;
            result += `> 验证报告: \`${outputPath}\`\n`;

            this._saveState(projectPath, { ...state, status: 'VERIFIED' });
        } else {
            // 统计遗漏项
            const remaining = this._parseChecklistStatus(outputPath);
            const pendingFiles = Object.keys(remaining).filter(f => remaining[f] === ' ');

            result += `## ⚠️ 仍有 ${pendingFiles.length} 个文件需要处理\n\n`;
            for (let i = 0; i < Math.min(pendingFiles.length, 10); i++) {
                result += `${i + 1}. \`${pendingFiles[i]}\`\n`;
            }
            result += `\n> 请继续选择文件进行适配。\n`;

            this._saveState(projectPath, {
                ...state,
                status: 'AUDITED',
                pending: pendingFiles
            });
        }

        return result;
    }

    // ========================
    // 辅助方法
    // ========================

    /** 从项目内加载状态 */
    _loadState(projectPath) {
        const stateFile = path.join(projectPath, '.compat_state.json');
        if (fs.existsSync(stateFile)) {
            try {
                return JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
            } catch (_) { }
        }
        return { status: 'INIT', completed: [], excluded: [], pending: [] };
    }

    /** 持久化状态到项目 */
    _saveState(projectPath, state) {
        const stateFile = path.join(projectPath, '.compat_state.json');
        try {
            fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf-8');
        } catch (e) {
            console.error(`[LocalizationExpert] 状态保存失败: ${e.message}`);
        }
    }

    /** 解析方言（从用户输入中识别源库和目标库） */
    _resolveDialects(input) {
        const lower = (input || '').toLowerCase();
        const sourceMap = {
            oracle: ['oracle', 'ora'],
            mysql: ['mysql', 'my']
        };
        const targetMap = {
            postgresql: ['postgresql', 'pgsql', 'pg', '瀚高'],
            gaussdb: ['gaussdb', 'gauss', '高斯'],
            dm: ['达梦', 'dm', 'dameng'],
            kingbase: ['人大金仓', 'kingbase', 'kb'],
            vastbase: ['vastbase', '海量']
        };

        let source = null, target = null;
        for (const [key, keywords] of Object.entries(sourceMap)) {
            if (keywords.some(k => lower.includes(k))) { source = key; break; }
        }
        for (const [key, keywords] of Object.entries(targetMap)) {
            if (keywords.some(k => lower.includes(k))) { target = key; break; }
        }

        // 默认推断
        if (!source && target) source = 'oracle';
        if (source && !target) target = 'postgresql';

        return { source, target };
    }

    /** 查找 YAML 规则配置文件 */
    _findRuleConfig(configFilename) {
        const searchRoots = new Set();
        // 基于 ruleService 的规则路径搜索
        if (this.ruleService && this.ruleService.rulesPath) {
            searchRoots.add(this.ruleService.rulesPath);
        }
        if (this.ruleService && this.ruleService.userRulesPath) {
            searchRoots.add(this.ruleService.userRulesPath);
        }

        // 辅助方法：在目录树中递归深度优先查找指定文件
        const findFileRecursively = (dir, targetName, depth = 0) => {
            // 防止递归过深导致栈溢出或无限循环，设定最大深度
            if (depth > 5 || !fs.existsSync(dir)) return null;

            try {
                const stats = fs.statSync(dir);
                if (!stats.isDirectory()) return null;

                const files = fs.readdirSync(dir);

                // 优先在当前层级查找
                for (const file of files) {
                    if (file === targetName) {
                        return path.join(dir, file);
                    }
                }

                // 未找到则递归进入子目录
                for (const file of files) {
                    // 排除性能杀手目录
                    if (file.startsWith('.git') || file === 'node_modules') continue;

                    const fullPath = path.join(dir, file);
                    if (fs.statSync(fullPath).isDirectory()) {
                        const result = findFileRecursively(fullPath, targetName, depth + 1);
                        if (result) return result;
                    }
                }
            } catch (e) {
                console.error(`[LocalizationExpert] Error traversing directory ${dir}:`, e);
            }
            return null;
        };

        for (const root of searchRoots) {
            if (!root) continue;

            // 优先尝试常见相对路径以提高速度
            const quickTryPaths = [
                path.join(root, '规则库', '数据库', configFilename),
                path.join(root, '数据库', configFilename),
                path.join(root, configFilename)
            ];

            for (const p of quickTryPaths) {
                if (fs.existsSync(p)) return p;
            }

            // 常见路径未命中，则进行全量降级递归查找
            const foundPath = findFileRecursively(root, configFilename);
            if (foundPath) return foundPath;
        }

        return null;
    }

    /** 获取 fast_audit.py 的路径 */
    _getScriptPath() {
        const candidates = [
            path.join(__dirname, '..', 'scripts', 'fast_audit.py'),
            path.join(__dirname, '..', 'mcp_tools', 'scripts', 'fast_audit.py')
        ];
        for (const p of candidates) {
            if (fs.existsSync(p)) return p;
        }
        throw new Error('找不到 fast_audit.py 审计脚本');
    }

    /** 解析清单中文件的标记状态 */
    _parseChecklistStatus(checklistPath) {
        const status = {};
        if (!fs.existsSync(checklistPath)) return status;

        const content = fs.readFileSync(checklistPath, 'utf-8');
        // 匹配总览区的 [状态]文件名.java 格式
        const matches = content.matchAll(/\[(.)\](\S+\.java)/g);
        for (const m of matches) {
            const mark = m[1];
            const filename = m[2];
            // 只保留第一次出现的状态（总览区优先）
            if (!(filename in status)) {
                status[filename] = mark;
            }
        }
        return status;
    }

    /** 从清单中提取指定文件的风险详情 */
    _extractFileRisks(checklistPath, targetFile) {
        if (!fs.existsSync(checklistPath)) return null;

        const content = fs.readFileSync(checklistPath, 'utf-8');

        // 查找详细清单中该文件的区块
        // 格式：##### - [ ] 📄 文件: `TargetFile.java`
        const escapedName = targetFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const fileBlockRegex = new RegExp(
            `#{4,5}\\s*-\\s*\\[.\\]\\s*📄\\s*文件:\\s*\`${escapedName}\`([\\s\\S]*?)(?=#{4,5}\\s*-\\s*\\[|#{3,4}\\s*📁|#{2,3}\\s*📂|$)`,
            'i'
        );
        const match = content.match(fileBlockRegex);
        if (!match) return null;

        const block = match[0] + match[1];

        // 提取完整路径
        const pathMatch = block.match(/\*\*完整路径\*\*:\s*`([^`]+)`/);

        // 提取方法级风险
        const methods = [];
        const methodRegex = /🔹\s*方法:\s*`([^`]+)`\s*\n\s*-\s*\*\*命中风险\*\*:\s*([^\n]+)/g;
        let methodMatch;
        while ((methodMatch = methodRegex.exec(block)) !== null) {
            methods.push({
                name: methodMatch[1],
                risks: methodMatch[2].trim()
            });
        }

        // 如果没有方法级信息，提取文件级风险
        if (methods.length === 0) {
            const riskRegex = /\*\*风险点\*\*:\s*`([^`]+)`\s*\(([^)]+)\)/g;
            let riskMatch;
            while ((riskMatch = riskRegex.exec(block)) !== null) {
                methods.push({
                    name: '(文件级)',
                    risks: riskMatch[2].trim()
                });
            }
        }

        if (methods.length === 0) return null;

        return {
            fullPath: pathMatch ? pathMatch[1] : null,
            methods: methods
        };
    }

    /** 加载 YAML 规则库的转换摘要表 */
    _loadConversionTable(configPath) {
        if (!configPath || !fs.existsSync(configPath)) return {};
        try {
            const yaml = require('js-yaml');
            const config = yaml.load(fs.readFileSync(configPath, 'utf-8'));
            const table = {};
            const flatRules = [];
            for (const item of (config.rules || [])) {
                if (item.rules && Array.isArray(item.rules)) {
                    flatRules.push(...item.rules);
                } else {
                    flatRules.push(item);
                }
            }
            for (const rule of flatRules) {
                if (rule.name && rule.replacement) {
                    table[rule.name] = rule.replacement;
                }
            }
            return table;
        } catch (_) {
            return {};
        }
    }

    /** 根据风险描述获取转换建议 */
    _getSuggestion(riskText, conversionTable) {
        const suggestions = [];
        for (const [name, replacement] of Object.entries(conversionTable)) {
            if (riskText.includes(name) || riskText.toLowerCase().includes(name.toLowerCase())) {
                suggestions.push(`\`${replacement}\``);
            }
        }
        // 补充常见模式
        if (riskText.includes('NVL')) suggestions.push('`COALESCE`');
        if (riskText.includes('SYSDATE')) suggestions.push('`CURRENT_TIMESTAMP`');
        if (riskText.includes('ROWNUM')) suggestions.push('`LIMIT`');
        if (riskText.includes('DECODE')) suggestions.push('`CASE WHEN`');

        return [...new Set(suggestions)].join(', ') || '-';
    }

    /** 从用户输入中提取 .java 文件名 */
    _extractFileName(input) {
        if (!input) return null;
        const match = input.match(/(\w+\.java)/i);
        return match ? match[1] : null;
    }

    /** 构建待处理文件列表 */
    _buildPendingFileList(projectPath, pendingFiles) {
        let result = `## 📋 待处理文件列表（共 ${pendingFiles.length} 个）\n\n`;
        const showCount = Math.min(pendingFiles.length, 20);
        for (let i = 0; i < showCount; i++) {
            result += `${i + 1}. \`${pendingFiles[i]}\`\n`;
        }
        if (pendingFiles.length > showCount) {
            result += `\n... 还有 ${pendingFiles.length - showCount} 个文件，请查看完整清单。\n`;
        }
        return result;
    }

    /** 构建"请选择文件"引导 */
    _buildPickFileGuide(projectPath, state, prefix) {
        const pending = state.pending || [];
        let result = prefix ? `${prefix}\n\n` : '';
        result += `📊 当前进度: ${(state.completed || []).length} 已完成 | ${pending.length} 待处理\n\n`;

        if (pending.length === 0) {
            result += `🎉 所有文件已处理！请调用 \`compatibility_audit_task(phase='verify')\` 进行验证。\n`;
        } else {
            result += this._buildPendingFileList(projectPath, pending);
            result += `\n> 请回复文件名开始适配，或输入"验证"进行检查。\n`;
        }
        return result;
    }
}

module.exports = LocalizationExpert;
