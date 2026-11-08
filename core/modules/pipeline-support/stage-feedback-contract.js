/* eslint-disable */
const REVISION_PHASES = Object.freeze(['structure_confirmed', 'details_confirmed', 'page_design_confirmed']);
const ROW_FIELDS = Object.freeze(['decisionRows', 'detailRows', 'compositionRows']);

function properties(design = false) {
    return {
        requestMode: { type: 'string', enum: ['revise'], description: '用户明确调整当前需求时使用 revise；普通继续不传。准备修订不携带答题数组，按返回的新步骤提交。' },
        affectedStoryIds: { type: 'array', minItems: 1, uniqueItems: true,
            items: { type: 'string', pattern: '^US[0-9]+$' }, description: '本次反馈影响的稳定 Story ID；省略表示全部。共享对象的影响范围由 Builder 按依赖扩展。' },
        feedback: { type: 'string', minLength: 1, maxLength: 2048, description: '用户已明确的修改内容；不是让 Builder 判断业务语义。' },
        ...(design ? { revisionPhase: { type: 'string', enum: REVISION_PHASES, description: 'LLM 判断本次最早需要修改的设计阶段。' } } : {})
    };
}

function conditions(design = false) {
    return [{ if: { properties: { requestMode: { const: 'revise' } }, required: ['requestMode'] },
        then: { required: ['feedback', ...(design ? ['revisionPhase'] : [])],
            ...(design ? { properties: { phase: { const: 'prepare' } } } : {}),
            not: { anyOf: [...ROW_FIELDS, 'stepId'].map(field => ({ required: [field] })) } },
        else: { not: { anyOf: ['feedback', 'affectedStoryIds', 'revisionPhase'].map(field => ({ required: [field] })) } }
    }];
}

function validate(args = {}, design = false) {
    let reason = '';
    if (args.requestMode !== undefined && args.requestMode !== 'revise') reason = 'requestMode 只允许 revise；普通恢复请省略。';
    else if (args.requestMode === 'revise') {
        if (typeof args.feedback !== 'string' || !args.feedback.trim() || args.feedback.length > 2048) reason = 'feedback 必须是 1～2048 字符的明确修改说明。';
        else if (design && !REVISION_PHASES.includes(args.revisionPhase)) reason = 'revisionPhase 必须为原有三个设计提交阶段之一。';
        else if ((design && args.phase !== undefined && args.phase !== 'prepare') || [...ROW_FIELDS, 'stepId'].some(field => args[field] !== undefined)) reason = '修订准备调用不能携带步骤标识或答题数组；先取得新卡再提交。';
        else if (args.affectedStoryIds !== undefined && (!Array.isArray(args.affectedStoryIds) || !args.affectedStoryIds.length
            || args.affectedStoryIds.some(id => typeof id !== 'string' || !/^US[0-9]+$/.test(id))
            || new Set(args.affectedStoryIds).size !== args.affectedStoryIds.length)) reason = 'affectedStoryIds 必须为不重复、非空的 Story ID 数组；全部范围请省略。';
    } else if (['feedback', 'affectedStoryIds', 'revisionPhase'].some(field => args[field] !== undefined)) reason = '反馈字段只用于 requestMode=revise；普通恢复请省略。';
    return reason ? { ok: false, status: 'repair_required', stopAfter: false, submissionApplied: false,
        errorCode: 'WORKFLOW_FEEDBACK_REQUEST_INVALID', message: reason,
        expectedShape: { requestMode: 'revise', feedback: '<用户明确的修改说明>', ...(design ? { revisionPhase: '<最早修改阶段>' } : {}) },
        allowedNextActions: ['resubmit_prepare_with_valid_feedback_request'] } : { ok: true };
}
module.exports = { properties, conditions, validate, REVISION_PHASES };
