const fs = require('fs');
const path = require('path');

class PipelineUtils {
    static get AI_WORKSPACE_DIR_NAME() {
        return '.ai-workspace';
    }

    static get AI_WORKSPACE_RUNS_DIR_NAME() {
        return 'runs';
    }

    static get AI_WORKSPACE_PROJECT_DIR_NAME() {
        return 'project';
    }

    static get AI_WORKSPACE_KNOWLEDGE_DIR_NAME() {
        return 'knowledge';
    }

    static getWorkspaceBaseDir(projectPath) {
        return path.join(projectPath, this.AI_WORKSPACE_DIR_NAME);
    }

    static getArtifactBaseDir(projectPath) {
        return path.join(this.getWorkspaceBaseDir(projectPath), this.AI_WORKSPACE_RUNS_DIR_NAME);
    }

    static getProjectStructureDir(projectPath) {
        return path.join(this.getWorkspaceBaseDir(projectPath), this.AI_WORKSPACE_PROJECT_DIR_NAME);
    }

    static getKnowledgeBaseDir(projectPath) {
        return path.join(this.getWorkspaceBaseDir(projectPath), this.AI_WORKSPACE_KNOWLEDGE_DIR_NAME);
    }

    static getApiAssetDir(projectPath) {
        return path.join(this.getKnowledgeBaseDir(projectPath), 'api-assets');
    }

    static getApiRuleDir(projectPath) {
        return path.join(this.getKnowledgeBaseDir(projectPath), 'api-rules');
    }

    static getRequirementMemoryDir(projectPath) {
        return path.join(this.getKnowledgeBaseDir(projectPath), 'requirements');
    }

    static getFeatureMemoryDir(projectPath) {
        return path.join(this.getKnowledgeBaseDir(projectPath), 'features');
    }

    static getRoutingTraceBaseDir(projectPath) {
        return path.join(this.getWorkspaceBaseDir(projectPath), 'traces', 'routing');
    }

    static normalizeFiniteChoiceInput(input) {
        return String(input || '').normalize('NFKC').trim();
    }

    static resolveFiniteChoiceInput(input, canonicalOptions = [], aliases = {}, options = {}) {
        const normalizedInput = this.normalizeFiniteChoiceInput(input);
        if (!normalizedInput) return '';

        const normalizedOptions = (Array.isArray(canonicalOptions) ? canonicalOptions : [])
            .map(item => this.normalizeFiniteChoiceInput(item))
            .filter(Boolean);
        if (!normalizedOptions.length) return '';

        const canonicalByNormalized = new Map();
        normalizedOptions.forEach((item, index) => {
            canonicalByNormalized.set(item, canonicalOptions[index]);
        });

        if (canonicalByNormalized.has(normalizedInput)) {
            return canonicalByNormalized.get(normalizedInput) || '';
        }

        const normalizedAliases = new Map();
        Object.entries(aliases || {}).forEach(([alias, value]) => {
            const normalizedAlias = this.normalizeFiniteChoiceInput(alias);
            const normalizedValue = this.normalizeFiniteChoiceInput(value);
            if (!normalizedAlias || !normalizedValue || !canonicalByNormalized.has(normalizedValue)) return;
            normalizedAliases.set(normalizedAlias, canonicalByNormalized.get(normalizedValue));
        });

        if (normalizedAliases.has(normalizedInput)) {
            return normalizedAliases.get(normalizedInput) || '';
        }

        const shortInputMaxLength = Number.isFinite(options.shortInputMaxLength)
            ? options.shortInputMaxLength
            : 12;
        if (normalizedInput.length > shortInputMaxLength) return '';

        const compactInput = normalizedInput.replace(/\s+/g, '');
        const numericMatch = compactInput.match(/^(?:选|第)?([1-9]\d?)(?:个|项|号)?[.、。)）]?$/u);
        if (!numericMatch) return '';

        const optionIndex = Number.parseInt(numericMatch[1], 10) - 1;
        if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= canonicalOptions.length) return '';
        return canonicalOptions[optionIndex] || '';
    }

    static resolveFrameworkVersionBucketPayload(payload, canonicalOptions = []) {
        const safePayload = payload && typeof payload === 'object' ? payload : {};
        const legacyAliases = {
            '950+': '950及以上',
            '950以上': '950及以上',
            '950及上': '950及以上',
            '950plus': '950及以上',
            '950-': '950以下'
        };
        const candidates = [
            { key: 'versionBucket', value: safePayload.versionBucket },
            { key: 'frameworkVersionBucket', value: safePayload.frameworkVersionBucket },
            { key: 'bucket', value: safePayload.bucket }
        ];
        for (const candidate of candidates) {
            const resolved = this.resolveFiniteChoiceInput(candidate.value, canonicalOptions, legacyAliases);
            if (resolved) {
                return {
                    versionBucket: resolved,
                    sourceKey: candidate.key,
                    rawValue: this.normalizeFiniteChoiceInput(candidate.value)
                };
            }
        }
        return {
            versionBucket: '',
            sourceKey: '',
            rawValue: ''
        };
    }

    static buildFrameworkVersionBucketInvalidMessage(payload, canonicalOptions = []) {
        const resolved = this.resolveFrameworkVersionBucketPayload(payload, canonicalOptions);
        const invalidValue = resolved.rawValue
            || this.normalizeFiniteChoiceInput(payload && payload.versionBucket)
            || this.normalizeFiniteChoiceInput(payload && payload.frameworkVersionBucket)
            || this.normalizeFiniteChoiceInput(payload && payload.bucket)
            || 'EMPTY';
        const detectedKeys = payload && typeof payload === 'object'
            ? Object.keys(payload).join(', ') || 'EMPTY'
            : 'EMPTY';
        const sampleBucket = canonicalOptions[0] || '950及以上';
        const sample = JSON.stringify({
            framework: 'management',
            versionBucket: sampleBucket
        }, null, 2);
        return [
            `FRAMEWORK_VERSION_BUCKET_INVALID: ${invalidValue}`,
            `检测到字段: ${detectedKeys}`,
            '期望 JSON 示例:',
            sample
        ].join('\n');
    }

    /**
     * 生成带 Emoji 的进度条
     */
    static getProgressVisual(currentStage, stageName) {
        const totalStages = 6;
        const processBar = Array(totalStages).fill('⚪');
        processBar[currentStage] = '🟢';
        return `**[${processBar.join('')}] Stage ${currentStage}: ${stageName}**`;
    }

    /**
     * 从用户意图中提取需求名称
     */
    static extractRequirementName(userIntent) {
        // 只取第一行，防止多行需求污染文件夹名
        const firstLine = String(userIntent || '').split(/[\r\n]/)[0] || String(userIntent || '');
        const withoutLeadingVerb = firstLine
            .replace(/^(?:请)?(?:帮我)?(?:开发|实现|创建|新增|增加|做|写|完成|需要)(?:一个|个)?/u, '')
            .trim();
        const firstBusinessPhrase = withoutLeadingVerb
            .split(/(?:包含|包括|支持|用于|以及|并且|同时|，|,|。|；|;|：|:|！|!|？|\?)/u)[0]
            || withoutLeadingVerb;
        const cleanedIntent = firstBusinessPhrase
            .replace(/(?:功能接口|接口功能|功能|接口|页面|模块|能力)$/u, '')
            .replace(/[。，、；：！？\.\,\;\:\!\?\s\n\r\t]/g, '') // 去除中英文标点和空白
            .trim();
        if (!cleanedIntent || cleanedIntent.length < 2) {
            return `需求_${Date.now()}`;
        }
        const folderName = cleanedIntent.substring(0, 16).replace(/[\\/:*?"<>|\[\]{}()（）【】]/g, '_');
        return `${this.getDateFolderPrefix()}_${folderName}_需求`;
    }

    static getDateFolderPrefix(date = new Date()) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}${month}${day}`;
    }

    static normalizeDatedRequirementFolderName(input, suffix = '_需求', fallbackIntent = '') {
        const normalizedSuffix = String(suffix || '_需求').trim() || '_需求';
        let stem = String(input || '').trim();
        if (!stem && fallbackIntent) {
            stem = this.extractRequirementName(fallbackIntent);
        }
        stem = stem
            .replace(/_(?:网站需求|需求)$/u, '')
            .replace(/[\\/:*?"<>|]/g, '')
            .trim();
        if (!stem) {
            stem = '未命名需求';
        }
        if (!/^\d{8}_/.test(stem)) {
            stem = `${this.getDateFolderPrefix()}_${stem}`;
        }
        return `${stem}${normalizedSuffix}`;
    }

    /**
     * 确保产出物文件夹存在
     */
    static ensureArtifactFolder(projectPath, folderName) {
        const artifactPath = path.join(this.getArtifactBaseDir(projectPath), folderName);
        if (!fs.existsSync(artifactPath)) {
            fs.mkdirSync(artifactPath, { recursive: true });
        }
        return artifactPath;
    }

    /**
     * 判断用户是否表示“确认”
     */
    static isConfirmation(input) {
        const normalized = this.normalizeFiniteChoiceInput(input).toLowerCase();
        if (!normalized) return false;

        const compact = normalized.replace(/[\s,，。.!！?？、:：;；"'`“”‘’()（）\[\]【】]/g, '');
        if (!compact) return false;

        const confirmKeywords = new Set([
            '1',
            '确认',
            '确认一下',
            '确认继续',
            '继续',
            '继续吧',
            '请继续',
            '下一步',
            '继续下一步',
            '好的',
            '好的继续',
            '可以继续',
            '没问题',
            '同意',
            'ok',
            'yes',
            'y',
            'go',
            'continue',
            'next'
        ]);

        return confirmKeywords.has(compact);
    }

    /**
     * 判断用户是否给出了“可推进步骤”的显式确认
     * 仅用于流水线步骤门禁，避免把“继续/好的/下一步”等宽松语气词误当成确认。
     */
    static isExplicitStepConfirmation(input) {
        const normalized = this.normalizeFiniteChoiceInput(input).toLowerCase();
        if (!normalized) return false;

        const compact = normalized.replace(/[\s,，。.!！?？、:：;；"'`“”‘’()（）\[\]【】]/g, '');
        if (!compact) return false;

        const explicitKeywords = new Set([
            '1',
            '确认',
            '确认一下',
            '确认继续',
            '请确认',
            '请确认继续'
        ]);

        return explicitKeywords.has(compact);
    }

    static resolveEffectiveUserIntent(input, fallback = '') {
        const normalizedInput = this.normalizeFiniteChoiceInput(input);
        const normalizedFallback = this.normalizeFiniteChoiceInput(fallback);
        if (!normalizedInput) return normalizedFallback;
        if (this.isConfirmation(normalizedInput)) return normalizedFallback || normalizedInput;
        if (this.isPipelineContinuationInput(normalizedInput)) return normalizedFallback || normalizedInput;
        return normalizedInput;
    }

    static isPipelineContinuationInput(input = '') {
        const text = String(input || '').trim();
        if (!text) return false;
        const compact = text.replace(/[\s,，。.!！?？、:：;；"'`“”‘’()（）\[\]【】]/g, '').toLowerCase();
        if (!compact) return false;
        if (/^继续(?:下一步|第?\d+步)?$/.test(compact)) return true;
        if (/^(?:进入|执行|调用)(?:下一步|第?\d+步|pipeline_\d+_[a-z_]+|website_pipeline_[a-z_]+)$/.test(compact)) return true;
        if (/^(?:继续|进入|执行|调用).*(?:pipeline_\d+_[a-z_]+|website_pipeline_[a-z_]+|需求规划|架构设计|代码生成|自检|沉淀)$/.test(compact)) return true;
        return false;
    }

    static looksLikeWebsiteScanIntake(input = '') {
        const text = String(input || '').trim();
        if (!text) return false;
        const hasSamplePage = /(?:参考页面|基准参考页面|samplePage)|(?:^|[\s，,：:])[\w:./\\-]+\.html(?:[\s，,。；;]|$)/i.test(text);
        const hasTargetFolder = /(?:文件夹名|网站所属文件夹名|所属文件夹|targetFolder)/i.test(text);
        const hasBucket = /(?:框架档位|950\s*(?:及以上|以下))/i.test(text);
        return hasBucket && (hasSamplePage || hasTargetFolder);
    }

    /**
     * 判断是否为全新的需求描述
     */
    static isNewRequirement(input, currentStatus) {
        if (currentStatus === 'INIT' || currentStatus === 'COMPLETED') return true;
        if (input.length < 5) return false;
        const newReqKeywords = ['帮我', '实现', '开发一个', '创建一个', '新增功能'];
        if (newReqKeywords.some(k => input.includes(k))) return true;
        return false;
    }

    /**
     * 生成动态推理引擎 的基础 Skeleton
     */
    static generateDynamicAnalystPrompt(context) {
        const {
            roleName = '资深需求分析师 (BA)',
            content,
            specFilePath,
            progress = '',
            guideContent,
            ruleContext,
            sceneRulesContent = '',
            coreRulesContent = '',
            ruleNamesPool = { demand: [], technical: [] }
        } = context;

        const demandList = ruleNamesPool.demand.map(n => `- ${n}`).join('\n');
        const technicalList = ruleNamesPool.technical.map(n => `- ${n}`).join('\n');

        const parts = [];
        parts.push(progress || '');
        parts.push(`## 🤖 Role: ${roleName || '资深需求分析师 (BA)'}`);
        parts.push('> **核心使命：严防“凭空捏造”，必须“按规对齐”，同步更新文档**');

        if (coreRulesContent) {
            parts.push('\n---\n## 🛡️ CORE PROTOCOLS (核心防护规约)');
            parts.push(coreRulesContent);
            parts.push('---');
        }

        if (sceneRulesContent) {
            parts.push('\n---\n## 🎯 [SCENE_PROTOCOL] 需求场景专用规约');
            parts.push(sceneRulesContent);
            parts.push('---');
        }

        parts.push('\n### 🛠️ 工作流指令 (Workflow Constraints)\n');

        parts.push('1.  **[必选] 规约关联透视 (Rule Association)**：');
        parts.push('    > 你必须仅从下方的 [已加载规则列表] 中复制规约名，严禁自行缩短或编造。');
        parts.push('    > **！！指令！！**：你的回复中必须完整列出关联规约及**关联原因**。');
        parts.push('    > - **📋 需求规约 Pool**：');
        parts.push(demandList || '*(暂无)*');
        parts.push('    > - **🛠️ 技术规约 Pool**：');
        parts.push(technicalList || '*(暂无)*');
        parts.push('    > - **格式要求**：- [原样规约名](关联原因: 关键词命中 / 场景匹配 / 核心约束 / 业务逻辑关联)\n');

        parts.push('2.  **[建议] 同步交付物 (SRS Sync)**：');
        parts.push(`    > 如果你有实质性的新分析结论，请同步更新 \`${specFilePath || 'SRS'}\`。`);
        parts.push('    > 如果当前仍处于初步沟通阶段，请优先通过对话框与用户对齐信息。\n');

        parts.push('3.  **[核心判定] 停止 & 澄清 (Stop & Ask)**：');
        parts.push('    > **如果**发现关键信息缺失（如：必填参数、对接文档、具体场景），请**直接在对话框中输出**【关键歧义澄清】卡片并等待用户回复。');
        parts.push('    > **！！禁令 (Anti-Tool Hijacking)！！**：**严禁调用任何提问工具（如 ask_user 或 question 工具）**。');
        parts.push('    > **！！禁令 (Anti-UI-Buttons)！！**：**严禁生成任何带有序号的选择控件（如 1. 2. 3. ...）**。你必须使用无序列表 `- ` 或 ` * ` 呈现问题，严禁触发 TRAE 的自动选项功能。');
        parts.push('    >');
        parts.push('    > **【关键歧义澄清】模板格式**：');
        parts.push('    > ```markdown');
        parts.push('    > ## 📝 需求调研与澄清');
        parts.push('    > ');
        parts.push('    > 作为 资深需求分析师 (BA)，依据以下规约及上下文对您的需求进行了初步扫描：');
        parts.push('    > ');
        parts.push('    > ### 🧩 关联规约透视');
        parts.push('    > - **[规约名A]**: 关联原因 (必须 100% 引用 Pool 中的名称)');
        parts.push('    > - **[规约名B]**: 关联原因 ');
        parts.push('    > ');
        parts.push('    > ### ❓ 待澄清关键点');
        parts.push('    > * **[业务语义歧义]**：... (请用柏拉图式反问风格)');
        parts.push('    > * **[缺失技术细节]**：... ');
        parts.push('    > ```\n');

        parts.push('---\n**[核心内容]**');
        parts.push(content || '');
        parts.push('\n---\n**[已加载的规则上下文 (Rule Context)]**');
        parts.push(ruleContext || "*(暂无预加载规则)*");
        parts.push('\n---\n**[补充规约：需求分析指南]**');
        parts.push(guideContent || "*(暂无相关指南)*");

        const prompt = parts.join('\n');

        console.error("DEBUG: progress value:", progress);
        console.error("DEBUG: prompt length:", prompt.length);
        if (Number.isNaN(prompt)) { console.error("DEBUG: prompt is NaN!"); }
        return prompt;
    }

    static extractJavaCodeBlocks(content) {
        if (!content) return [];
        const matches = [...content.matchAll(/```java\s*([\s\S]*?)```/g)];
        return matches.map(m => m[1].trim());
    }

    static extractCodeTemplateFromMarkdown(content, lookupKey) {
        if (!content) return null;
        const escapedKey = lookupKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const headerRegex = new RegExp(`^(##+)\\s+.*${escapedKey}.*[\\r\\n]+([\\s\\S]*?)(?=[\\r\\n]##+|$)`, 'm');
        const match = content.match(headerRegex);
        let searchScope = content;
        if (match) {
            searchScope = match[2];
        }
        const codeBlockMatch = searchScope.match(/```java\s*([\s\S]*?)```/);
        if (codeBlockMatch) {
            return codeBlockMatch[1].trim();
        }
        return null;
    }
}

module.exports = PipelineUtils;
