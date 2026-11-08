/* eslint-disable */
/**
 * Matcher: 物理表名标识符（snake_case 格式）泄露
 * expert 端：简单 snake_case 正则
 * website 端：由 LeakPolicyRegistry 调用 matchPhysicalSchemaIdentifier(text, context) 传入 safeSnakeCaseIdentifiers
 */

// 简单 snake_case 匹配（expert 端使用）
const SNAKE_CASE_REGEX = /\b[a-z][a-z0-9]{1,}_[a-z][a-z0-9]{1,}(?:_[a-z][a-z0-9]{1,}){0,}\b/;

// 宽松 snake_case 匹配（website 端使用，用于提取后再过滤）
const LOOSE_SNAKE_CASE_REGEX = /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/g;

module.exports = function matchPhysicalSchemaIdentifier(text, context) {
    // 去除命名声明行（表特征名/tableFeatureName）和 BUSINESS_NAMING_RESULT JSON 块后再检测，
    // 因为这些是设计阶段的合法命名线索，不是物理表名泄漏
    const cleaned = String(text || '')
        .replace(/(?:表特征名|tableFeatureName)\s*[：:=|]\s*[a-z_]+/gi, '')
        // 清洗 BUSINESS_NAMING_RESULT JSON 块中的 snake_case 值，避免与命名合同冲突
        .replace(/"tableFeatureName"\s*:\s*"[a-z_]+"/gi, '');

    // website 端传入 context.safeSnakeCaseIdentifiers 时走宽松匹配+白名单过滤
    if (context && context.safeSnakeCaseIdentifiers instanceof Set && context.safeSnakeCaseIdentifiers.size > 0) {
        const matches = cleaned.match(LOOSE_SNAKE_CASE_REGEX) || [];
        const filtered = matches
            .map(item => String(item || '').trim())
            .filter(Boolean)
            .filter(item => !context.safeSnakeCaseIdentifiers.has(item.toLowerCase()));
        return filtered.length > 0;
    }
    // expert 端：简单正则
    return SNAKE_CASE_REGEX.test(cleaned);
};
