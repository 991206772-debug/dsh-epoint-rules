/* eslint-disable */
/**
 * Matcher: 字段类型 / 物理存储设计泄露
 * 检测 varchar、char、datetime、decimal 等字段类型关键字
 * int/tinyint 用负向后查保护（如 application/x-www-form-urlencoded 中的 "int" 不误报）
 */
module.exports = function matchColumnType(text) {
    const regex = /\b(?:varchar|char|nvarchar|datetime|timestamp|date|decimal|numeric|bigint|tinyint|text)\s*(?:\(|\b)|(?<![/-])\bint\b\s*(?:\(|\b)/i;
    return regex.test(text);
};
