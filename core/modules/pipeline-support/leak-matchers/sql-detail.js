/* eslint-disable */
/**
 * Matcher: SQL / ORM 级实现细节泄露
 * 检测 CREATE TABLE、INSERT INTO、ALTER TABLE、DROP TABLE、@Entity、@Table
 */
module.exports = function matchSqlDetail(text) {
    return /\bcreate\s+table\b|insert\s+into|alter\s+table|drop\s+table|@Entity\s*\(|@Table\s*\(/i.test(text);
};
