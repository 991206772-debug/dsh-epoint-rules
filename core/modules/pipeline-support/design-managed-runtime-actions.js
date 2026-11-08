/* eslint-disable */

// 所有可能消费 Design/Design TDD 受管运行态的公开动作只在这里登记。
// dispatch 的统一 recover 覆盖由此表派生，新增动作不允许自行绕过 WAL。
const DESIGN_MANAGED_RUNTIME_ACTIONS = Object.freeze([
    'design_prepare_context',
    'design_tdd_build_plan',
    'design_tdd_skeleton_materialize'
]);

const DESIGN_MANAGED_RUNTIME_ACTION_SET = new Set(DESIGN_MANAGED_RUNTIME_ACTIONS);

module.exports = {
    DESIGN_MANAGED_RUNTIME_ACTIONS,
    DESIGN_MANAGED_RUNTIME_ACTION_SET
};
