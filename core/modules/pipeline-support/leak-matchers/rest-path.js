/* eslint-disable */
/**
 * Matcher: REST 路径泄露
 * 只检测真正的路径格式泄露（/xxx/xxx），不检测英文业务词汇（rest/controller）。
 * 'rest' 和 'controller' 在业务描述中是合法词汇（如"REST 接口"、"controller 层"），
 * 检测它们会误伤正常的需求说明书内容。
 */
module.exports = function matchRestPath(text) {
    const value = String(text || '');
    if (!value.trim()) return false;
    return /(?:^|[\s"'`:(（【])\/[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)+(?=$|[\s"'`),，。；;:：）】])/i.test(value);
};
