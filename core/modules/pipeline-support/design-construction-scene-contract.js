/* eslint-disable */

const ALL_LINKED_TABLE_KINDS = Object.freeze(['new', 'reuse', 'none']);

const CONSTRUCTION_SCENE_CONTRACTS = Object.freeze({
    crud_new_full: Object.freeze({ allowedLinkedTableKinds: ['new'], needsPageMode: 'optional' }),
    backend_data_carrier: Object.freeze({ allowedLinkedTableKinds: ['new'], needsPageMode: 'optional' }),
    query_result_entry: Object.freeze({ allowedLinkedTableKinds: ['reuse', 'none'], needsPageMode: 'required' }),
    statistics_analysis: Object.freeze({ allowedLinkedTableKinds: ['reuse', 'none'], needsPageMode: 'required' }),
    workflow_process: Object.freeze({ allowedLinkedTableKinds: ALL_LINKED_TABLE_KINDS, needsPageMode: 'required' }),
    rest_interface: Object.freeze({ allowedLinkedTableKinds: ALL_LINKED_TABLE_KINDS, needsPageMode: 'forbidden' }),
    scheduled_job: Object.freeze({ allowedLinkedTableKinds: ALL_LINKED_TABLE_KINDS, needsPageMode: 'forbidden' }),
    configuration_only: Object.freeze({ allowedLinkedTableKinds: ['none'], needsPageMode: 'forbidden' }),
    existing_entry_patch: Object.freeze({ allowedLinkedTableKinds: ['reuse', 'none'], needsPageMode: 'forbidden' }),
    mixed_prepare_then_patch: Object.freeze({ allowedLinkedTableKinds: ALL_LINKED_TABLE_KINDS, needsPageMode: 'conditional' }),
    targeted_patch_only: Object.freeze({ allowedLinkedTableKinds: ['reuse', 'none'], needsPageMode: 'forbidden' })
});

const CONSTRUCTION_SCENE_KEYS = Object.freeze(Object.keys(CONSTRUCTION_SCENE_CONTRACTS));

function getConstructionSceneContract(scene = '') {
    return CONSTRUCTION_SCENE_CONTRACTS[String(scene || '').trim()] || null;
}

function sceneSupportsLinkedTableKind(scene = '', kind = '') {
    const contract = getConstructionSceneContract(scene);
    return !!(contract && contract.allowedLinkedTableKinds.includes(String(kind || '').trim().toLowerCase()));
}

function getNeedsPageMode(scene = '') {
    const contract = getConstructionSceneContract(scene);
    return contract ? contract.needsPageMode : 'optional';
}

module.exports = {
    CONSTRUCTION_SCENE_CONTRACTS,
    CONSTRUCTION_SCENE_KEYS,
    getConstructionSceneContract,
    sceneSupportsLinkedTableKind,
    getNeedsPageMode
};
