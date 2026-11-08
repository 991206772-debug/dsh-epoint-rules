const fs = require('fs');
const path = require('path');

/**
 * PageRuleExtractor — 网站页面规则逆向提取引擎 (V2.5 - 全栈变量回溯版)
 * 核心逻辑：从 JS 调用反向推理 HTML 配置块，自适应 Config/Config.ajaxUrls/_settings 等多种命名。
 */
class PageRuleExtractor {
    /**
     * 执行分析并生成 page-rules.md
     * @param {string[]} filePaths 参考页面路径数组
     * @param {string} projectPath 项目根路径
     * @returns {string} 生成的 page-rules.md 内容
     */
    static extract(filePaths, projectPath) {
        if (!filePaths || filePaths.length === 0) return "";

        const results = {
            samplePages: filePaths,
            head: { doctype: '', meta: [], bootJs: '', links: [], scriptsHead: [] },
            body: { classes: '', placeholders: [], scriptsBody: [] },
            template: { scriptType: 'text/template', idRule: '', settings: '', mustacheExamples: [] },
            businessJs: {
                codeStructure: [],
                ajaxMode: 'Util.ajax',
                requestFormat: 'B',
                backendReturnUtil: '',
                successCode: '',
                successCodeValue: '',
                dataPath: '',
                listField: '',
                totalField: '',
                utils: [],
                pagination: '',
                dialog: '',
                events: '',
                settingsUsage: 'flat',
                ajaxSnippet: '',
                responseSnippet: '',
                backendReturnMirror: '', // 💡 记录后端物理返回语句镜像
                backendJsonUtilsImport: '', // 💡 记录 JsonUtils 的导包路径
                potentialSettingsVars: [] // 💡 记录从 JS 中反推出来的配置变量名
            }
        };

        const contents = filePaths.map(p => {
            if (!fs.existsSync(p)) return null;
            return { path: p, content: fs.readFileSync(p, 'utf-8'), ext: path.extname(p).toLowerCase() };
        }).filter(Boolean);

        // 第一步：先扫 JS，抓取接口调用范式并反推配置变量名
        contents.filter(c => c.ext === '.js').forEach(c => this._analyzeJs(c.content, results));

        // 第二步：扫 HTML，识别静态结构，并根据 JS 反推的变量名寻找配置块
        contents.filter(c => c.ext === '.html').forEach(c => this._analyzeHtml(c.content, results));

        // 第三步：扫 Java，抓取后端返回范式
        contents.filter(c => c.ext === '.java').forEach(c => this._analyzeJava(c.content, results));

        return this._formatToMarkdown(results);
    }

    static _analyzeHtml(content, results) {
        const doctypeMatch = content.match(/<!DOCTYPE\s+([^>]+)>/i);
        if (doctypeMatch) results.head.doctype = doctypeMatch[1].trim();

        const metaMatches = content.matchAll(/<meta[^>]+>/gi);
        for (const m of metaMatches) {
            if (!results.head.meta.includes(m[0])) results.head.meta.push(m[0]);
        }

        const headMatch = content.match(/<head>([\s\S]*?)<\/head>/i);
        if (headMatch) {
            const headContent = headMatch[1];
            const linkMatches = headContent.matchAll(/<link[^>]+href=["']([^"']+)["'][^>]*>/gi);
            for (const m of linkMatches) {
                if (!results.head.links.includes(m[1])) results.head.links.push(m[1]);
            }
            const scriptMatches = headContent.matchAll(/<script[^>]+src=["']([^"']+)["'][^>]*>/gi);
            for (const m of scriptMatches) {
                if (!results.head.scriptsHead.includes(m[1])) results.head.scriptsHead.push(m[1]);
                if (m[1].includes('boot.min.js')) results.head.bootJs = m[1];
            }
        }

        const bodyTagMatch = content.match(/<body[^>]*class=["']([^"']+)["'][^>]*>/i);
        if (bodyTagMatch) results.body.classes = bodyTagMatch[1];

        const bodyMatch = content.match(/<body[^]*?>([\s\S]*?)<\/body>/i);
        if (bodyMatch) {
            const bodyContent = bodyMatch[1];
            
            const ids = ['header', 'nav', 'footer', 'sidebar', 'container', 'content', 'breadcrumb', 'pagination', 'pager'];
            ids.forEach(id => {
                const regex = new RegExp(`<([^\\s>]+)[^>]*id=["']${id}["'][^>]*>([\\s\\S]*?)<\\/\\1>`, 'i');
                const match = bodyContent.match(regex);
                if (match) {
                    results.body.placeholders.push({
                        id, tag: match[1],
                        outerHTML: match[0].split('\n')[0] + ' ... ' + match[0].split('\n').pop()
                    });
                }
            });

            const mustacheMatch = bodyContent.match(/<script[^>]+type=["']text\/template["'][^>]*id=["']([^"']+)["'][^>]*>([\s\S]*?)<\/script>/i);
            if (mustacheMatch) {
                results.template.idRule = mustacheMatch[1];
                results.template.mustacheExamples.push(mustacheMatch[2].trim().slice(0, 200) + '...');
            }

            // ⭐ 配置块提取 (反向回溯核心逻辑)
            // 1. 先尝试通用的 _settings
            let settingsMatch = content.match(/(?:var|window\.)?\s*_settings\s*=\s*({[\s\S]*?});/);
            
            // 2. 如果没找到，尝试根据 JS 中记录的潜在变量名回溯
            if (!settingsMatch && results.businessJs.potentialSettingsVars.length > 0) {
                for (const varName of results.businessJs.potentialSettingsVars) {
                    const escapedVar = varName.replace(/\./g, '\\.');
                    // 匹配变量定义的起始直到语句结束
                    const dynamicRegex = new RegExp(`(?:var|window\\.)?\\s*${escapedVar}\\s*=\\s*({[\\s\\S]*?});?`, 'm');
                    settingsMatch = content.match(dynamicRegex);
                    if (settingsMatch) break;
                }
            }

            if (settingsMatch) results.template.settings = settingsMatch[0].trim();
        }
    }

    static _analyzeJs(content, results) {
        if (content.includes('Util.ajax')) results.businessJs.ajaxMode = 'Util.ajax';
        else if (content.includes('$.ajax')) results.businessJs.ajaxMode = '$.ajax';

        const ajaxRegex = /(Util\.ajax|\$\.ajax)\s*\(\s*\{([\s\S]+?)\}\s*\)/g;
        const matches = [...content.matchAll(ajaxRegex)];
        
        if (matches.length > 0) {
            results.businessJs.ajaxSnippet = matches[0][0].trim();

            matches.forEach(m => {
                const ajaxBody = m[2];
                const urlMatch = ajaxBody.match(/url\s*:\s*([^,}\s]+)/);
                if (urlMatch) {
                    const urlVal = urlMatch[1].trim();
                    if (!urlVal.startsWith("'") && !urlVal.startsWith('"') && !urlVal.startsWith('`')) {
                        const parts = urlVal.split('.');
                        if (parts.length > 1) {
                            const prefix = parts.slice(0, -1).join('.');
                            if (!results.businessJs.potentialSettingsVars.includes(prefix)) {
                                results.businessJs.potentialSettingsVars.push(prefix);
                            }
                        }
                    }
                }
            });

            const successLogicMatch = results.businessJs.ajaxSnippet.match(/success\s*:\s*function\s*\(\w+\)\s*\{([\s\S]*?)\}/);
            if (successLogicMatch) {
                results.businessJs.responseSnippet = successLogicMatch[1].trim();
            }
        }

        const varsToCheck = ['_settings', ...results.businessJs.potentialSettingsVars];
        for (const v of varsToCheck) {
            const escapedV = v.replace(/\./g, '\\.');
            if (content.match(new RegExp(`${escapedV}\\s*\\.\\s*(be|fe)\\.`))) {
                results.businessJs.settingsUsage = 'nested';
                break;
            } else if (content.match(new RegExp(`${escapedV}\\s*\\.\\s*[a-zA-Z0-9_$]+`))) {
                results.businessJs.settingsUsage = 'flat';
            }
        }

        // ⭐ 入参格式探测：探测是否包含 params 包装（Format A）
        // 兼容 data: { params: ... } 或 var param = { params: ... } 后传给 data 的情形
        if (content.match(/params\s*:\s*{/) || content.match(/data\s*:\s*{\s*params\s*:/)) {
            results.businessJs.requestFormat = 'A'; // 包装模式
        } else {
            results.businessJs.requestFormat = 'B'; // 扁平模式
        }
        // ⭐ 出参字段探测：增加对 msg.custom.xxx 等嵌套路径的识别
        // 1. 匹配 Mustache 渲染或对象内部映射: { items: msg.custom.dictlist }
        // 2. 匹配变量直接赋值: var list = msg.custom.tasklist;
        const respRoots = ['resp', 'data', 'res', 'msg'];
        const complexRegex = new RegExp(`(?:items|list|data|\\w+list)\\s*[:=]\\s*(${respRoots.join('|')})\\.([\\w\\.]+)`, 'gi');
        
        let fm;
        while ((fm = complexRegex.exec(content)) !== null) {
            const root = fm[1];
            const path = fm[2];
            const lowerPath = path.toLowerCase();
            
            // 优先选择业务感强的字段名
            if (lowerPath.includes('list') || lowerPath.includes('data')) {
                // 如果路径包含 custom，则保留全路径
                results.businessJs.listField = path;
            }
            if (lowerPath.includes('total') || lowerPath.includes('count')) {
                results.businessJs.totalField = path;
            }
        }

        const successMatch = content.match(/if\s*\((resp|data|res|msg)\.code\s*==\s*['"]?1['"]?\)/);
        if (successMatch) results.businessJs.successCode = `${successMatch[1]}.code == 1`;

        // 提取 API URL (示例采样)
        const urlMatch = content.match(/url\s*:\s*(?:serverjkip\s*\+\s*)?['"]\/?([^'"]+)['"]/);
        if (urlMatch) results.businessJs.apiUrl = urlMatch[1];

        const utilMatches = content.matchAll(/Util\.(\w+)\(/g);
        for (const m of utilMatches) {
            if (!results.businessJs.utils.includes(m[1])) results.businessJs.utils.push(m[1]);
        }

        if (content.includes('paging(') || content.includes('pagination')) results.businessJs.pagination = '已探测到分页逻辑';
        if (content.includes('layer.') || content.includes('msg(')) results.businessJs.dialog = '已探测到弹窗(layer)逻辑';
        if (content.includes('.on(') || content.includes('.click(')) results.businessJs.events = '已探测到事件绑定模式';
    }

    static _analyzeJava(content, results) {
        // 1. 探测导包 (Import Sensing)
        const importMatch = content.match(/import\s+([\w\.]+\.JsonUtils);/i);
        if (importMatch) {
            results.businessJs.backendJsonUtilsImport = importMatch[1];
        }

        // 2. 探测返回语句 (Return Sensing)
        const returnMatch = content.match(/return\s+([\w\.]+)\.(\w+)\(\s*([^;]+)\);/i);
        if (returnMatch) {
            results.businessJs.backendReturnUtil = `${returnMatch[1]}.${returnMatch[2]}`;
            results.businessJs.successCodeValue = returnMatch[3].split(',')[0].trim();
            // 💡 物理镜像：捕获整行作为参考
            results.businessJs.backendReturnMirror = `return ${returnMatch[1]}.${returnMatch[2]}(${returnMatch[3]});`;
        }
        const putMatch = content.match(/\.put\s*\(\s*["']([^"']+)["']\s*,\s*[^)]+\)/g);
        if (putMatch) {
            putMatch.forEach(m => {
                const fMatch = m.match(/"([^"]+)"/);
                if (fMatch) {
                    const field = fMatch[1];
                    if (!results.businessJs.utils.includes(`后端字段:${field}`)) {
                        results.businessJs.utils.push(`后端字段:${field}`);
                    }
                }
            });
        }
    }

    static _formatToMarkdown(results) {
        const configName = results.businessJs.potentialSettingsVars.length > 0 
            ? results.businessJs.potentialSettingsVars.join(' / ') 
            : '_settings';

        return `# 页面规则 - 精确提取报告 (镜像级采样版)

> 基于样本页面深度逆向分析：
${results.samplePages.map(p => `> - ${p}`).join('\n')}

---

## ⚡️ 一、 [全链路] 资源加载镜像空间 (Resource Skeleton)

### 1.1 头部资源引入 (<head> 镜像)
**必须** 严格按照以下顺序在 \`<head>\` 中引入资源。严禁多余引用：
\`\`\`html
<!DOCTYPE ${results.head.doctype || 'html'}>
<head>
    <meta charset="UTF-8">
    ${results.head.meta.slice(0, 3).join('\n    ')}
    <script src="${results.head.bootJs || '../../js/boot/boot.min.js'}"></script>
    <script>
        // 样式与公共插件注册区
        ResBoot.output([
            ${results.head.links.map(l => `'${l}'`).join(',\n            ')},
            './css/{{PAGE_NAME}}.css'
        ]);
    </script>
</head>
\`\`\`

### 1.2 尾部脚本加载 (<body> 底部)
**必须** 放在 \`</body>\` 标签前最后位置点：
\`\`\`html
<script>
    // 业务逻辑与页面自身插件加载
    ResBoot.output([
        ${results.body.scriptsBody.filter(s => s).map(s => `'${s}'`).join(',\n        ')}${results.body.scriptsBody.length > 0 ? ',\n        ' : ''}'./js/{{PAGE_NAME}}.js'
    ]);
</script>
\`\`\`

---

## 二、 [Layout层] 页面结构与骨架占位 (Layout Snapshot)

### 2.1 关键 ID 容器 (Mandatory Containers)
生成 HTML 时，**必须使用** 对应的标签和 ID 结构，以确保主题 CSS 正常渲染：
\`\`\`html
${results.body.placeholders.map(p => `<!-- ${p.id} -->\n<${p.tag} id="${p.id}">${p.outerHTML.includes('...') ? '...' : ''}</${p.tag}>`).join('\n')}
\`\`\`

### 2.2 列表模板镜像 (Mustache Template Mirror)
如果涉及搜索列表，**必须** 使用以下 ID 的 Mustache 模板：
- **模板 ID**: \`${results.template.idRule || '未探测到'}\`
- **代码快照**:
\`\`\`html
<script type="text/template" id="${results.template.idRule || 'list-template'}">
    ${results.template.mustacheExamples[0] || '// 典型 Mustache 结构渲染占位'}
</script>
\`\`\`

---

## 三、 [HTML层] 接口配置范式 (Registration Pattern)

### 3.1 全局配置块 (${configName})
你必须在 HTML 的末尾（资源加载完成后） **原样复刻** 此结构的定义：
\`\`\`javascript
${results.template.settings || '// ⚠️ 未探测到配置块，请手动检查 HTML 中的变量定义'}
\`\`\`

---

## 四、 [JS层] Ajax 调用镜像 (Mirror Usage)

### 4.1 核心调用代码 (镜像级采样 - 严禁 AI 改动)
**必须** 严格模仿此调用范式（包括工具类、参数结构、URL 访问路径）：
\`\`\`javascript
${results.businessJs.ajaxSnippet || '// ⚠️ 提取失败，请参考项目中现有 JS 的 Util.ajax 调用方式'}
\`\`\`

### 4.2 调用路径规约 (重要)
- **Settings 访问路径**: \`${results.businessJs.settingsUsage === 'flat' ? '⚠️ 强制扁平访问 (禁止在 JS 中添加 .be 或 .fe)' : '嵌套访问'}\`
- **路径示例**: \`${results.businessJs.settingsUsage === 'flat' ? (results.businessJs.potentialSettingsVars[0] || '_settings') + '.xxx' : (results.businessJs.potentialSettingsVars[0] || '_settings') + '.be.xxx'}\`

---

## 五、 [规范项] 数据协议与解析 (Data Protocol)

### 5.1 请求协议 (Request)
- **前端工具**: \`${results.businessJs.ajaxMode}\`
- **入参包结构**: \`格式 ${results.businessJs.requestFormat}\` (A: params包裹, B: 扁平直接传)

### 5.2 出参协议 (Response)
- **核心接口 (采样)**: \`${results.businessJs.apiUrl || '动态变量拼接'}\`
- **后端返回工具类**: \`${results.businessJs.backendReturnUtil || '标准 REST'}\`
- **成功判定逻辑**: \`${results.businessJs.successCode || 'msg.code == 1'}\`
- **列表数据路径**: \`${results.businessJs.listField || '未探测到'}\` (AI 请注意：如果是 $.ajax，通常需要 \`msg.custom.\` 前缀)
- **总条目数路径**: \`${results.businessJs.totalField || '未探测到'}\`

### 5.3 后端接口物理快照 (Physical Blueprint)
> **勘测员必填**：请物理阅读 Controller 中的返回行，并将原始采样复制于此。
- **导包镜像**: \`import ${results.businessJs.backendJsonUtilsImport || '// ⚠️ 尚未采集到，请勘测员手动 view_file 后在此补齐导包'};\`
- **返回镜像**:
\`\`\`java
${results.businessJs.backendReturnMirror || '// ⚠️ 脚本未自动捕获到完整行，请勘测员手动在此补齐'}
\`\`\`

---

## 🛠️ 六、 公共工具与插件资产 (Util & Plugins)

### 6.1 已探测到的 Util 方法 (API WhiteList)
**优先复用** 项目中已存在的静态方法，禁止 AI 自行实现同类逻辑：
- **核心工具类**: \`${results.businessJs.ajaxMode}\`
- **已调用方法**: \`${results.businessJs.utils.length > 0 ? results.businessJs.utils.join(' | ') : '尚未深度采集'}\`

### 6.2 UI 扩展组件 (Plugins Mirror)
- **分页组件**: \`${results.businessJs.pagination || '未探测到或手动配置'}\`
- **弹窗组件**: \`${results.businessJs.dialog || '未探测到或手动配置'}\`
- **交互事件**: \`${results.businessJs.events || '默认模式'}\`

---

## 七、 交付规约 (Hard Rules)
- **Body Class**: \`${results.body.classes || '无'}\`
- **同名化规范**: 所有 HTML/JS/CSS **必须同名** 存放在 \`webapp/{项目}/pages/{功能名}/\`。
- **资源路径**: 所有外部引用必须使用 **相对路径** (\`../../\`)，禁止使用绝对路径。
`;
    }
}

module.exports = PageRuleExtractor;
