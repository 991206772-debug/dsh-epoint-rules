/* eslint-disable */
/**
 * Matcher: 物理约束设计泄露
 * 检测 PK、FK、PRIMARY KEY、FOREIGN KEY、非空、唯一、默认值
 */
module.exports = function matchSchemaConstraint(text) {
    return /\b(?:pk|fk|primary key|foreign key|非空|唯一|默认值)\b/i.test(text);
};
