/* eslint-disable */
/**
 * Matcher: 具体类名/实现名泄露
 * 检测 XxxService/XxxServiceImpl/XxxAction/XxxController 等实现类名
 *
 * website 端可传入 context.namespaceProfiles 进行动态 profile 匹配
 * expert 端不传 profiles，使用通用正则
 *
 * 保护："XxxService接口使用规范" 等规则引用名不算泄露
 */
module.exports = function matchClassName(text, context) {
    const profileList = Array.isArray(context && context.namespaceProfiles)
        ? context.namespaceProfiles.filter(Boolean)
        : [];
    const pattern = profileList.length > 0
        ? new RegExp(`\\bI?(?:${profileList.join('|')})[A-Za-z0-9_]+Service(?:Impl)?\\b(?!接口使用规范)|\\b(?:${profileList.join('|')})[A-Za-z0-9_]+(?:Action|Controller)\\b`, 'i')
        : /\b(?:I?[A-Z][A-Za-z0-9_]+Service(?:Impl)?|[A-Z][A-Za-z0-9_]+(?:Action|Controller))\b(?!接口使用规范)/;
    return pattern.test(text);
};

