/* eslint-disable */

function normalizeContent(content = '') {
    return String(content || '').replace(/\r\n/g, '\n');
}

function validateHeadingOrder(content, headings = []) {
    const text = String(content || '');
    let previousIndex = -1;
    for (const heading of Array.isArray(headings) ? headings : []) {
        const currentIndex = text.indexOf(heading);
        if (currentIndex < 0 || currentIndex <= previousIndex) return false;
        previousIndex = currentIndex;
    }
    return true;
}

function normalizeHeadingForMatch(value = '') {
    return String(value || '')
        .replace(/\r\n/g, '\n')
        .split('\n')[0]
        .replace(/^#+\s*/, '')
        .replace(/^(?:\d+(?:[.．]\d+)*|[一二三四五六七八九十百千万]+)[、.．]?\s*/, '')
        .replace(/[（(][^）)]*[）)]/g, '')
        .replace(/[：:]\s*$/, '')
        .replace(/\s+/g, '')
        .trim();
}

function validateHeadingPresence(content, headings = []) {
    const actualHeadings = normalizeContent(content)
        .split('\n')
        .filter(line => /^#{1,6}\s+/.test(line.trim()))
        .map(line => normalizeHeadingForMatch(line.trim()))
        .filter(Boolean);
    return (Array.isArray(headings) ? headings : [])
        .map(item => normalizeHeadingForMatch(item))
        .filter(Boolean)
        .every(expected => actualHeadings.some(actual => actual === expected || actual.includes(expected) || expected.includes(actual)));
}

function hasUnfilledTemplateMarker(content) {
    // 检测规则驱动模板占位符：TEMPLATE_FILL_REQUIRED、中文待填类、中文待AI填类、方括号待填写类
    return /TEMPLATE_FILL_REQUIRED|待补充|待[^\s]{0,4}?(?:AI|填写|补充|补全)|[（(]本节待|待\s*AI\s*填写|\[[^\]]*?请(?:在此处)?(?:填写|补[充全])|请在此处填写/g.test(String(content || ''));
}

function extractSectionByHeadingKeyword(content, keywords = [], options = {}) {
    const lines = normalizeContent(content).split('\n');
    const headingPrefixes = Array.isArray(options.headingPrefixes) && options.headingPrefixes.length > 0
        ? options.headingPrefixes
        : ['## '];
    const boundaryPrefixes = Array.isArray(options.boundaryPrefixes) && options.boundaryPrefixes.length > 0
        ? options.boundaryPrefixes
        : headingPrefixes;
    const normalizedKeywords = (Array.isArray(keywords) ? keywords : [])
        .map(item => String(item || '').trim())
        .filter(Boolean);
    const isHeading = line => headingPrefixes.some(prefix => line.startsWith(prefix));
    const isBoundary = line => boundaryPrefixes.some(prefix => line.startsWith(prefix));
    const start = lines.findIndex(line => isHeading(line) && normalizedKeywords.some(keyword => line.includes(keyword)));
    if (start === -1) return '';

    let end = lines.length;
    for (let index = start + 1; index < lines.length; index += 1) {
        if (isBoundary(lines[index])) {
            end = index;
            break;
        }
    }
    return lines.slice(start, end).join('\n');
}

function extractSubsectionByHeadingKeyword(content, keywords = []) {
    return extractSectionByHeadingKeyword(content, keywords, {
        headingPrefixes: ['### '],
        boundaryPrefixes: ['## ', '### ']
    });
}

function extractMarkdownTableRows(content) {
    return normalizeContent(content)
        .split('\n')
        .filter(line => /^\|.*\|$/.test(line.trim()))
        .filter(line => !/^(\|\s*:?-{2,}:?\s*)+\|$/.test(line.trim()));
}

function hasMermaidOrPlantumlDiagram(sectionContent) {
    return /```(?:mermaid|plantuml)/i.test(String(sectionContent || ''));
}

function buildNamingSectionTemplate(intentContext = '', domain = '') {
    const ctx = String(intentContext || '').trim();
    const dom = String(domain || '').trim();
    const domainLine = dom ? `业务域：${dom}` : '业务域：（从需求概述提炼，如：电子证照、项目管理）';
    return [
        '## 业务对象与数据模型',
        '',
        domainLine,
        '',
        '**业务对象**：' + (ctx ? `「${ctx}」涉及的核心业务实体` : '（从功能清单提炼主业务实体）'),
        '',
        '**业务实体**：`[英文 PascalCase，来自业务对象语义]`',
        '',
        '**模块缩写**：`[从需求模块名提取英文缩写，如：certify / project / wzmcp]`',
        '',
        '**表特征名**：`[若有存储需求，用英文下划线命名，来自业务对象语义]`',
        ''
    ].join('\n');
}

module.exports = {
    validateHeadingOrder,
    validateHeadingPresence,
    normalizeHeadingForMatch,
    hasUnfilledTemplateMarker,
    extractSectionByHeadingKeyword,
    extractSubsectionByHeadingKeyword,
    extractMarkdownTableRows,
    hasMermaidOrPlantumlDiagram,
    buildNamingSectionTemplate
};
