/* eslint-disable */

// 模板选择是文件事实的机械投影。计划与物化共用，避免各自维护默认值。
function resolveSkeletonSectionKey(fileKind, fileEntry = {}) {
    const kind = String(fileKind || '').trim();
    const entry = fileEntry || {};
    const sub = String(entry.subType || '').trim().toLowerCase();
    if (kind === 'Action' || kind === 'HtmlPage') {
        if (entry.statisticsOnly === true) return kind === 'Action' ? 'StatisticsAction' : 'StatisticsHtmlPage';
        if (entry.queryOnly === true && (!sub || sub === 'list')) {
            return kind === 'Action' ? 'ReuseQueryListAction' : 'ReuseQueryListHtmlPage';
        }
    }
    const explicit = String(entry.sectionKey || '').trim();
    if (explicit) return explicit;
    if (kind === 'Rest') return 'RestController';
    if (kind === 'Action') {
        return { list: 'ListAction', mylist: 'WorkflowMyListAction', add: 'AddAction', edit: 'EditAction',
            detail: 'DetailAction', workflow: 'WorkflowAction' }[sub] || 'ListAction';
    }
    if (kind === 'HtmlPage') {
        return { list: '列表页', mylist: 'WorkflowMyListHtmlPage', add: '新增页', edit: '编辑页', detail: '详情页',
            workflow: 'WorkflowHtmlPage', workflowdetail: 'WorkflowDetailHtmlPage' }[sub] || sub;
    }
    return kind;
}

module.exports = resolveSkeletonSectionKey;
