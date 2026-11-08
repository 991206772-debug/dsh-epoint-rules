/* eslint-disable */
/**
 * Matcher: 主表/子表/历史表拆分泄露
 * 检测"主表"、"子表"、"历史表"、"同步日志表"等提前拍板表拆分的表述
 */
module.exports = function matchTableSplit(text) {
    return /主表|子表|历史表|同步日志表/.test(text);
};
