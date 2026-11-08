const fs = require('fs');
const path = require('path');

class PageCompositionExtractor {
    static extract(filePaths = [], projectPath = '') {
        const sourceFiles = (Array.isArray(filePaths) ? filePaths : [])
            .map(item => String(item || '').trim())
            .filter(Boolean);
        const samples = sourceFiles
            .filter(filePath => fs.existsSync(filePath) && fs.statSync(filePath).isFile())
            .map(filePath => ({
                path: filePath,
                relativePath: this._relativePath(projectPath, filePath),
                ext: path.extname(filePath).toLowerCase(),
                content: fs.readFileSync(filePath, 'utf-8')
            }));

        const htmlSamples = samples.filter(item => item.ext === '.html' || item.ext === '.htm');
        const jsSamples = samples.filter(item => item.ext === '.js');
        const cssSamples = samples.filter(item => item.ext === '.css');
        const javaSamples = samples.filter(item => item.ext === '.java');
        const allText = samples.map(item => item.content).join('\n');

        const pageComposition = {
            entryFiles: this._extractEntryFiles(samples, projectPath),
            resourceLoading: this._extractResourceLoading(htmlSamples),
            layoutRegions: this._extractLayoutRegions(htmlSamples),
            templateBlocks: this._extractTemplateBlocks(htmlSamples),
            configRegistry: this._extractConfigRegistry(htmlSamples, jsSamples),
            dataFlows: this._extractDataFlows(jsSamples),
            rendering: this._extractRendering(htmlSamples, jsSamples),
            widgets: this._extractWidgets(allText, samples),
            eventsAndNavigation: this._extractEventsAndNavigation(jsSamples),
            styleConstraints: this._extractStyleConstraints(htmlSamples),
            backendObservations: this._extractBackendObservations(javaSamples)
        };

        return {
            ok: true,
            sourceType: 'page_composition',
            generatedAt: new Date().toISOString(),
            sourceFiles: samples.map(item => item.relativePath || item.path),
            sampleCount: samples.length,
            pageComposition,
            warnings: this._buildWarnings(pageComposition, samples)
        };
    }

    static toMarkdown(payload = {}) {
        const composition = payload.pageComposition || {};
        const section = (title, items) => [
            `## ${title}`,
            '```json',
            JSON.stringify(items || {}, null, 2),
            '```'
        ].join('\n');
        return [
            '# 页面组成部分逆向提取报告',
            '',
            '## 样本文件',
            ...(Array.isArray(payload.sourceFiles) ? payload.sourceFiles : []).map(item => `- ${item}`),
            '',
            section('1. 页面文件结构', composition.entryFiles),
            section('2. 资源加载方式', composition.resourceLoading),
            section('3. 页面布局区域', composition.layoutRegions),
            section('4. 模板系统', composition.templateBlocks),
            section('5. 配置入口', composition.configRegistry),
            section('6. 数据请求协议', composition.dataFlows),
            section('7. 返回数据与渲染绑定', composition.rendering),
            section('8. 交互组件', composition.widgets),
            section('9. 事件与导航行为', composition.eventsAndNavigation),
            section('10. 样式与视觉约束', composition.styleConstraints),
            section('11. 后端返回镜像', composition.backendObservations),
            '',
            '## Warnings',
            ...(Array.isArray(payload.warnings) && payload.warnings.length > 0 ? payload.warnings : ['无']).map(item => `- ${item}`),
            '',
            '## 机器契约快照',
            '```json page-composition',
            JSON.stringify(payload, null, 2),
            '```'
        ].join('\n');
    }

    static _relativePath(projectPath = '', filePath = '') {
        const root = String(projectPath || '').trim();
        if (!root) return filePath;
        const relative = path.relative(root, filePath);
        return relative && !relative.startsWith('..') ? relative.replace(/\\/g, '/') : filePath;
    }

    static _evidence(sample, match, extra = {}) {
        const index = typeof match === 'number' ? match : (match && typeof match.index === 'number' ? match.index : -1);
        const lineNumber = index >= 0 ? sample.content.slice(0, index).split(/\r?\n/).length : null;
        return {
            sourceFile: sample.relativePath || sample.path,
            lineNumber,
            ...extra
        };
    }

    static _fact(kind, value, evidence = [], requiredForGeneration = true, confidence = 0.85) {
        return {
            kind,
            value,
            evidence: Array.isArray(evidence) ? evidence : [evidence].filter(Boolean),
            sourceFiles: [...new Set((Array.isArray(evidence) ? evidence : [evidence])
                .map(item => item && item.sourceFile)
                .filter(Boolean))],
            confidence,
            requiredForGeneration
        };
    }

    static _extractEntryFiles(samples, projectPath) {
        const files = samples.map(sample => ({
            type: sample.ext.replace(/^\./, '') || 'unknown',
            path: sample.relativePath || sample.path,
            baseName: path.basename(sample.path, sample.ext),
            dir: this._relativePath(projectPath, path.dirname(sample.path))
        }));
        const html = files.find(item => item.type === 'html' || item.type === 'htm');
        const siblingNames = new Set(files.map(item => `${item.type}:${item.baseName}`));
        return {
            files,
            sameNameTriplet: Boolean(html && siblingNames.has(`js:${html.baseName}`) && siblingNames.has(`css:${html.baseName}`)),
            helperDirectories: [...new Set(files.map(item => item.dir.split('/').pop()).filter(Boolean))]
                .filter(name => ['js', 'css', 'images', '_test', '_include'].includes(name.toLowerCase()))
        };
    }

    static _extractResourceLoading(htmlSamples) {
        const links = [];
        const scripts = [];
        const registryCalls = [];
        htmlSamples.forEach(sample => {
            for (const match of sample.content.matchAll(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/gi)) {
                links.push(this._fact('link', match[1], [this._evidence(sample, match)]));
            }
            for (const match of sample.content.matchAll(/<script\b[^>]*src=["']([^"']+)["'][^>]*>/gi)) {
                scripts.push(this._fact('script', match[1], [this._evidence(sample, match)]));
            }
            for (const match of sample.content.matchAll(/\b([A-Za-z_$][\w$]*Boot)\.output\s*\(\s*\[([\s\S]*?)\]\s*\)/g)) {
                registryCalls.push(this._fact('resource_registry', {
                    callee: `${match[1]}.output`,
                    resources: this._extractStringLiterals(match[2])
                }, [this._evidence(sample, match)]));
            }
        });
        const bootScripts = scripts.filter(item => /(?:cssboot|jsboot|boot\.min)\.js/i.test(String(item.value || '')));
        const values = [...links, ...scripts].map(item => String(item.value || ''));
        return {
            mode: registryCalls.length > 0 ? 'registry' : (links.length || scripts.length ? 'direct' : 'missing_evidence'),
            pathStyle: values.some(item => item.startsWith('/')) ? 'absolute' : (values.some(item => item.includes('../')) ? 'relative' : 'mixed_or_unknown'),
            bootScripts,
            links,
            scripts,
            registryCalls
        };
    }

    static _extractLayoutRegions(htmlSamples) {
        const regions = [];
        const classify = text => {
            const lower = String(text || '').toLowerCase();
            const map = [
                ['header', /header|qh-header|approveheader/],
                ['nav', /\bnav\b|menu|navbar/],
                ['breadcrumb', /breadcrumb|position|crumb|curr-position/],
                ['search', /search|keyword|query|filter|txtsearch/],
                ['tab', /tab|data-role=["']tab/],
                ['list', /list|ul\b|tasklist|projectlist|provelist/],
                ['table', /table|tbody|datatable/],
                ['form', /form|input|select|textarea/],
                ['pager', /pager|pagination|page/],
                ['sidebar', /sidebar/],
                ['footer', /footer|qh-footer/]
            ];
            const hit = map.find(([, regex]) => regex.test(lower));
            return hit ? hit[0] : 'container';
        };
        htmlSamples.forEach(sample => {
            for (const match of sample.content.matchAll(/<([a-z][\w:-]*)\b([^>]*)>/gi)) {
                const attrs = match[2] || '';
                if (!/(id|class|data-role|data-menucode)=/i.test(attrs)) continue;
                const id = this._attr(attrs, 'id');
                const className = this._attr(attrs, 'class');
                const dataRole = this._attr(attrs, 'data-role');
                const dataMenucode = this._attr(attrs, 'data-menucode');
                const signature = [id, className, dataRole, dataMenucode].filter(Boolean).join(' ');
                const type = classify(signature || match[0]);
                if (['container'].includes(type) && !id && !dataRole) continue;
                regions.push(this._fact(type, {
                    tag: match[1],
                    id,
                    className,
                    dataRole,
                    dataMenucode
                }, [this._evidence(sample, match)], type !== 'container', 0.78));
            }
        });
        return regions.slice(0, 80);
    }

    static _extractTemplateBlocks(htmlSamples) {
        const blocks = [];
        htmlSamples.forEach(sample => {
            for (const match of sample.content.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
                const attrs = match[1] || '';
                const type = this._attr(attrs, 'type');
                const id = this._attr(attrs, 'id');
                if (!type || !/text\/(?:x-template|template|html)/i.test(type)) continue;
                const body = match[2] || '';
                blocks.push(this._fact('script_template', {
                    id,
                    type,
                    variables: this._extractTemplateVariables(body),
                    listRoots: this._extractMustacheSections(body),
                    snippet: body.trim().slice(0, 240)
                }, [this._evidence(sample, match)], true, 0.9));
            }
            for (const match of sample.content.matchAll(/<((?:wrapper)?(?:common|line|last|page|pagelist|link|speciallevel2common|speciallevel2line)template)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
                blocks.push(this._fact('custom_template_tag', {
                    tag: match[1],
                    variables: this._extractTemplateVariables(match[2] || ''),
                    snippet: String(match[2] || '').trim().slice(0, 200)
                }, [this._evidence(sample, match)], true, 0.8));
            }
        });
        return blocks;
    }

    static _extractConfigRegistry(htmlSamples, jsSamples) {
        const declarations = [];
        const usedKeys = new Set();
        jsSamples.forEach(sample => {
            for (const match of sample.content.matchAll(/\b(_settings|window\.pageConfig|pageConfig|Config|ajaxUrls)((?:\.[A-Za-z_$][\w$]*){1,3})/g)) {
                const rawKey = `${match[1]}${match[2]}`;
                usedKeys.add(rawKey);
                if (match[1] === '_settings') {
                    usedKeys.add(rawKey.replace(/^_settings\.(?:be|fe)\./, '_settings.'));
                }
            }
        });
        htmlSamples.forEach(sample => {
            for (const match of sample.content.matchAll(/(?:var|window\.)\s*(_settings|pageConfig|Config|ajaxUrls)\s*=\s*({[\s\S]*?})\s*;?/g)) {
                const name = match[0].startsWith('window.') ? `window.${match[1]}` : match[1];
                declarations.push(this._fact('config_declaration', {
                    name,
                    keys: this._extractObjectKeys(match[2]),
                    usedKeys: [...usedKeys].filter(key => key.startsWith(`${name}.`) || key.startsWith(`${match[1]}.`)),
                    snippet: match[0].trim().slice(0, 400)
                }, [this._evidence(sample, match)], true, 0.82));
            }
        });
        return {
            declarations,
            usedKeys: [...usedKeys],
            missingEvidence: declarations.length === 0
        };
    }

    static _extractDataFlows(jsSamples) {
        const flows = [];
        jsSamples.forEach(sample => {
            const ajaxRegex = /(Util\.ajax|\$\.ajax|epoint\.execute)\s*\(\s*({[\s\S]*?})\s*\)/g;
            for (const match of sample.content.matchAll(ajaxRegex)) {
                const body = match[2] || '';
                const urlExpression = this._extractProperty(body, 'url') || this._extractFirstString(body);
                const utilPolicy = this._buildUtilAjaxPolicy(match[1], urlExpression, body);
                flows.push(this._fact('ajax_flow', {
                    tool: match[1],
                    urlExpression,
                    effectiveUrlExpression: utilPolicy.effectiveUrlExpression || urlExpression,
                    method: this._extractProperty(body, 'type') || this._extractProperty(body, 'method') || '',
                    requestShape: /params\s*:/.test(body) ? 'params_wrapped' : 'flat_or_unknown',
                    requestPayloadPolicy: utilPolicy.requestPayloadPolicy,
                    configAccessPolicy: utilPolicy.configAccessPolicy,
                    forbiddenPatterns: utilPolicy.forbiddenPatterns,
                    warnings: utilPolicy.warnings,
                    successLogic: this._extractSuccessLogic(body),
                    responseFields: this._extractResponseFields(body),
                    errorHandling: this._extractErrorHandling(body),
                    snippet: match[0].trim().slice(0, 1200)
                }, [this._evidence(sample, match)], true, 0.86));
            }
            for (const match of sample.content.matchAll(/\$\.ajax\s*\(\s*{[\s\S]*?url\s*:\s*serverjkip\s*\+\s*["']([^"']+)["'][\s\S]*?}\s*\)/g)) {
                flows.push(this._fact('serverjkip_ajax_flow', {
                    tool: '$.ajax',
                    urlExpression: `serverjkip + ${match[1]}`,
                    responseFields: this._extractResponseFields(match[0])
                }, [this._evidence(sample, match)], true, 0.86));
            }
        });
        return flows;
    }

    static _extractBackendObservations(javaSamples) {
        const observations = [];
        javaSamples.forEach(sample => {
            for (const match of sample.content.matchAll(/import\s+([\w.]+\.JsonUtils);/gi)) {
                observations.push(this._fact('json_utils_import', {
                    importName: match[1],
                    mirror: `import ${match[1]};`
                }, [this._evidence(sample, match)], false, 0.82));
            }
            for (const match of sample.content.matchAll(/return\s+([\w.]+)\.(\w+)\(\s*([^;]+?)\s*\);/gi)) {
                observations.push(this._fact('return_mirror', {
                    utility: `${match[1]}.${match[2]}`,
                    arguments: match[3].trim(),
                    mirror: `return ${match[1]}.${match[2]}(${match[3].trim()});`
                }, [this._evidence(sample, match)], false, 0.82));
            }
            for (const match of sample.content.matchAll(/\.put\s*\(\s*["']([^"']+)["']\s*,\s*[^)]+\)/g)) {
                observations.push(this._fact('response_field', {
                    field: match[1],
                    mirror: match[0]
                }, [this._evidence(sample, match)], false, 0.72));
            }
        });
        return observations.slice(0, 80);
    }

    static _buildUtilAjaxPolicy(tool = '', urlExpression = '', body = '') {
        const normalizedTool = String(tool || '').trim();
        if (normalizedTool !== 'Util.ajax') {
            return {
                effectiveUrlExpression: urlExpression,
                requestPayloadPolicy: 'use_detected_call_shape',
                configAccessPolicy: 'use_detected_url_expression',
                forbiddenPatterns: [],
                warnings: []
            };
        }
        const warnings = [];
        const forbiddenPatterns = [
            'data.token',
            'data.params.token',
            'Util.ajax data 包含 token 外壳',
            '_settings.be.xxx',
            '_settings.fe.xxx'
        ];
        const effectiveUrlExpression = String(urlExpression || '').replace(/_settings\.(?:be|fe)\./g, '_settings.');
        if (/_settings\.(?:be|fe)\./.test(String(urlExpression || ''))) {
            warnings.push('UTIL_AJAX_SETTINGS_NAMESPACE_SHOULD_BE_STRIPPED: Util.ajax 已封装 be/fe 命名空间，调用时应使用 _settings.xxx');
        }
        if (/\btoken\s*:/.test(String(body || ''))) {
            warnings.push('UTIL_AJAX_TOKEN_ENVELOPE_DETECTED: Util.ajax data 不应携带 token 外壳，只传业务参数或 params 内层参数');
        }
        return {
            effectiveUrlExpression,
            requestPayloadPolicy: 'Util.ajax data 只传业务参数；若接口需要 params，则传 { params: {...} }，禁止同时包 token。',
            configAccessPolicy: 'Util.ajax URL 使用 _settings.xxx；若 HTML 配置按 be/fe 分组，JS 调用也不写 .be/.fe。',
            forbiddenPatterns,
            warnings
        };
    }

    static _extractRendering(htmlSamples, jsSamples) {
        const bindings = [];
        jsSamples.forEach(sample => {
            for (const match of sample.content.matchAll(/\b(?:Mustache|M)\.render\s*\(\s*\$\(["']#([^"']+)["']\)\.html\(\)\s*,\s*([^)]+)\)/g)) {
                bindings.push(this._fact('mustache_render', {
                    templateId: match[1],
                    dataExpression: match[2].trim(),
                    target: this._findNearestRenderTarget(sample.content, match.index)
                }, [this._evidence(sample, match)], true, 0.86));
            }
            for (const match of sample.content.matchAll(/Util\.render\s*\(\s*["']#([^"']+)["']\s*,\s*([^,]+)\s*,\s*["']#([^"']+)["']\s*\)/g)) {
                bindings.push(this._fact('util_render', {
                    templateId: match[1],
                    dataExpression: match[2].trim(),
                    target: `#${match[3]}`
                }, [this._evidence(sample, match)], true, 0.88));
            }
            if (/\+?\s*['"]<[^'"]+>/.test(sample.content)) {
                bindings.push(this._fact('manual_dom_string', {
                    snippet: (sample.content.match(/\+?\s*['"]<[^'"]+>[\s\S]{0,160}/) || [''])[0]
                }, [this._evidence(sample, sample.content.search(/\+?\s*['"]<[^'"]+>/))], true, 0.68));
            }
        });
        const templateIds = new Set();
        htmlSamples.forEach(sample => {
            for (const match of sample.content.matchAll(/<script\b([^>]*)>/gi)) {
                const attrs = match[1] || '';
                const type = this._attr(attrs, 'type');
                const id = this._attr(attrs, 'id');
                if (id && /text\/(?:x-template|template|html)/i.test(type)) {
                    templateIds.add(id);
                }
            }
        });
        return {
            templateIds: [...templateIds],
            bindings
        };
    }

    static _extractWidgets(text, samples) {
        const specs = [
            ['pagination', /pagination\s*\(/i],
            ['layer_message', /layer\.(?:msg|alert|confirm|open)\s*\(/i],
            ['tab', /\bTabView\s*\(|data-role=["']tab/i],
            ['swiper', /\bSwiper\s*\(|swiper/i],
            ['chosen', /chosen\(/i],
            ['datepicker', /date(?:time)?picker/i],
            ['upload', /webuploader|upload/i],
            ['qrcode', /qrcode/i],
            ['mustache', /\bMustache\b/i]
        ];
        return specs
            .filter(([, regex]) => regex.test(text))
            .map(([kind, regex]) => {
                const sample = samples.find(item => regex.test(item.content)) || samples[0] || { content: '', path: '' };
                return this._fact(kind, kind, [this._evidence(sample, sample.content.search(regex))], true, 0.76);
            });
    }

    static _extractEventsAndNavigation(jsSamples) {
        const events = [];
        jsSamples.forEach(sample => {
            for (const match of sample.content.matchAll(/(?:\.on|\.bind|\.click)\s*\(\s*["']([^"']+)["']/g)) {
                events.push(this._fact('event_binding', {
                    event: match[1],
                    snippet: match[0]
                }, [this._evidence(sample, match)], false, 0.72));
            }
            for (const match of sample.content.matchAll(/(?:location\.href|window\.open)\s*=?\s*([^;\n]+)/g)) {
                events.push(this._fact('navigation', {
                    expression: match[0].trim()
                }, [this._evidence(sample, match)], true, 0.78));
            }
        });
        return events.slice(0, 80);
    }

    static _extractStyleConstraints(htmlSamples) {
        const bodyClasses = [];
        const mainContainers = [];
        htmlSamples.forEach(sample => {
            const bodyMatch = sample.content.match(/<body\b([^>]*)>/i);
            if (bodyMatch) {
                const className = this._attr(bodyMatch[1], 'class');
                if (className) bodyClasses.push(this._fact('body_class', className, [this._evidence(sample, bodyMatch)]));
            }
            for (const match of sample.content.matchAll(/<div\b([^>]*)>/gi)) {
                const className = this._attr(match[1], 'class');
                if (/(container|content|main|article)/i.test(className)) {
                    mainContainers.push(this._fact('main_container_class', className, [this._evidence(sample, match)], true, 0.7));
                }
            }
        });
        return {
            bodyClasses,
            mainContainers: mainContainers.slice(0, 20)
        };
    }

    static _buildWarnings(pageComposition, samples) {
        const warnings = [];
        if (!samples.length) warnings.push('PAGE_COMPOSITION_NO_VALID_SAMPLE_FILES');
        if (pageComposition.resourceLoading.mode === 'missing_evidence') warnings.push('PAGE_COMPOSITION_RESOURCE_LOADING_MISSING');
        if (!pageComposition.templateBlocks.length) warnings.push('PAGE_COMPOSITION_TEMPLATE_BLOCKS_MISSING');
        if (pageComposition.configRegistry.missingEvidence) warnings.push('PAGE_COMPOSITION_CONFIG_REGISTRY_MISSING');
        if (!pageComposition.dataFlows.length) warnings.push('PAGE_COMPOSITION_DATA_FLOWS_MISSING');
        return warnings;
    }

    static _attr(attrs = '', name = '') {
        const regex = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i');
        const match = String(attrs || '').match(regex);
        return match ? match[1] : '';
    }

    static _extractStringLiterals(text = '') {
        return [...String(text || '').matchAll(/["']([^"']+)["']/g)].map(match => match[1]);
    }

    static _extractTemplateVariables(text = '') {
        return [...new Set([...String(text || '').matchAll(/{{{?\s*[#/]?([\w.]+)\s*}?}}/g)].map(match => match[1]))].slice(0, 40);
    }

    static _extractMustacheSections(text = '') {
        return [...new Set([...String(text || '').matchAll(/{{#\s*([\w.]+)\s*}}/g)].map(match => match[1]))].slice(0, 20);
    }

    static _extractObjectKeys(text = '') {
        return [...new Set([...String(text || '').matchAll(/([A-Za-z_$][\w$]*)\s*:/g)].map(match => match[1]))].slice(0, 80);
    }

    static _extractProperty(text = '', prop = '') {
        const regex = new RegExp(`${prop}\\s*:\\s*([^,}\\n]+)`, 'i');
        const match = String(text || '').match(regex);
        return match ? match[1].trim() : '';
    }

    static _extractFirstString(text = '') {
        const match = String(text || '').match(/["']([^"']+)["']/);
        return match ? match[1] : '';
    }

    static _extractSuccessLogic(text = '') {
        const match = String(text || '').match(/if\s*\(([^)]*\bcode\b[^)]*)\)/i);
        return match ? match[1].trim() : '';
    }

    static _extractResponseFields(text = '') {
        return [...new Set([...String(text || '').matchAll(/\b(?:data|msg|resp|result)\.([A-Za-z_$][\w$.]*)/g)].map(match => match[0]))].slice(0, 40);
    }

    static _extractErrorHandling(text = '') {
        const handlers = [];
        if (/layer\.(?:msg|alert|confirm|open)\s*\(/i.test(text)) handlers.push('layer');
        if (/\balert\s*\(/i.test(text)) handlers.push('alert');
        if (/\bempty|none|no[-_]?data|暂无|没有找到/.test(text)) handlers.push('empty_state');
        return handlers;
    }

    static _findNearestRenderTarget(content = '', index = 0) {
        const before = String(content || '').slice(Math.max(0, index - 160), index + 160);
        const htmlMatch = before.match(/\$\(["']#([^"']+)["']\)\.html\s*\(/);
        return htmlMatch ? `#${htmlMatch[1]}` : '';
    }
}

module.exports = PageCompositionExtractor;
