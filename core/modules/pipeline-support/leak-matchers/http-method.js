/* eslint-disable */
/**
 * Matcher: HTTP Method / Mapping 实现泄露
 *
 * 语境区分：
 * - "采用POST方式" / "使用POST方法" / "使用POST协议" → 描述外部接口协议事实，不报错
 * - @PostMapping 注解 → 一定是实现泄露，报错
 * - "POST /api/xxx" 形式 → 实现泄露，报错
 *
 * contextExemptions 由契约 JSON 驱动，未来可外化更多豁免模式
 */
module.exports = function matchHttpMethod(text, context) {
    // @XxxMapping 注解一定是实现泄露
    if (/@(?:Get|Post|Put|Delete|Patch|Request)Mapping\b/.test(text)) return true;

    // 没出现 HTTP Method 关键词则不匹配
    if (!/\b(?:GET|POST|PUT|DELETE|PATCH)\b/.test(text)) return false;

    // 检查 contextExemptions（来自契约 JSON）
    const exemptions = Array.isArray(context && context.contextExemptions) ? context.contextExemptions : [];
    for (const exemption of exemptions) {
        if (exemption.pattern && new RegExp(exemption.pattern, 'i').test(text)) {
            return false;
        }
    }

    return true;
};
