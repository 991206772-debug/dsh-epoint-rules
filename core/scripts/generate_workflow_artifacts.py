#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Generate Epoint/F9 workflow XML artifacts from a design Builder packet.

The plugin owns this mechanical generator. It writes the design-stage
MIS/workflow XML artifacts under the packet's outputRoot.
"""

import argparse
import json
import os
import random
import re
import sys
import uuid
from datetime import datetime
from xml.etree import ElementTree as ET


class ArtifactError(Exception):
    pass


def _as_text(value, default=""):
    if value is None:
        return default
    return str(value).strip()


def _first(*values):
    for value in values:
        text = _as_text(value)
        if text:
            return text
    return ""


def _array(value):
    return value if isinstance(value, list) else []


ASCII_STABLE_CONSTANT_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:/-]*$")


def _normalize_sql_type(value):
    text = _as_text(value).lower()
    if text in ("date", "datetime", "timestamp"):
        return "datetime"
    if text in ("int", "integer", "number"):
        return "Integer"
    if text in ("numeric", "decimal", "double", "float"):
        return "Numeric"
    return "nvarchar"


def _normalize_field_length(field_type, length):
    text = _as_text(length)
    if text:
        return text
    if field_type == "datetime":
        return ""
    if field_type == "Integer":
        return ""
    if field_type == "Numeric":
        return "18,2"
    return "200"


def _safe_module(value):
    text = _as_text(value).lower()
    out = "".join(ch if ch.isalnum() or ch in ("_", "-") else "_" for ch in text)
    out = out.strip("_-")
    return out or "workflow"


def _read_json(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def _write_text(path, content):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(content)


def _extract_packet(raw):
    if not isinstance(raw, dict):
        raise ArtifactError("input must be a JSON object")

    packet = raw.get("workflowTaskPacket") if isinstance(raw.get("workflowTaskPacket"), dict) else {}
    if not packet:
        raise ArtifactError("workflowTaskPacket wrapper is required")
    card = packet.get("workflowWorkCard") if isinstance(packet.get("workflowWorkCard"), dict) else {}

    contract = (
        packet.get("workflowContract")
        or packet.get("contract")
        or card.get("workflowContract")
        or card.get("contract")
    )
    if not isinstance(contract, dict):
        raise ArtifactError("workflowContract/contract is required")

    biz_module = _first(
        packet.get("bizModule"),
        card.get("bizModule"),
        contract.get("bizModule"),
        packet.get("pageName"),
        packet.get("moduleId"),
    )
    safe_module = _safe_module(biz_module)

    output_root = _first(packet.get("outputRoot"), card.get("outputRoot"))
    if not output_root:
        design_dir = _first(packet.get("designDir"), card.get("designDir"))
        if design_dir:
            output_root = os.path.join(design_dir, "generated-workflow")
    if not output_root:
        raise ArtifactError("outputRoot or designDir is required")
    output_root = os.path.abspath(output_root)

    table = packet.get("businessTable") or card.get("businessTable") or {}
    if not isinstance(table, dict):
        table = {}
    columns = (
        packet.get("businessColumns")
        or card.get("businessColumns")
        or table.get("businessColumns")
        or table.get("columns")
        or []
    )

    table_name = _first(
        packet.get("tableName"),
        card.get("tableName"),
        table.get("tableName"),
        table.get("sqlTableName"),
        safe_module,
    )
    table_comment = _first(
        packet.get("tableComment"),
        card.get("tableComment"),
        table.get("tableComment"),
        table.get("tableNameCn"),
        contract.get("processName"),
        table_name,
    )

    return {
        "outputRoot": output_root,
        "bizModule": safe_module,
        "tableName": table_name,
        "tableComment": table_comment,
        "businessColumns": _array(columns),
        "workflowContract": contract,
        "workflowExternalMethodSeeds": _array(packet.get("workflowExternalMethodSeeds") or contract.get("workflowExternalMethodSeeds")),
        "serviceInternalTypeName": _first(packet.get("serviceInternalTypeName"), contract.get("serviceInternalTypeName")),
    }


class MisXmlGenerator:
    FIELD_TYPE_MAP = {
        "nvarchar": {"fieldNumType": "2", "fielddisplaytype": "textbox", "fieldtypename": "字符串型"},
        "Integer": {"fieldNumType": "12", "fielddisplaytype": "textbox", "fieldtypename": "整数型"},
        "datetime": {"fieldNumType": "", "fielddisplaytype": "datepicker", "fieldtypename": "日期型"},
        "Numeric": {"fieldNumType": "22", "fielddisplaytype": "textbox", "fieldtypename": "小数型"},
    }

    DEFAULT_FIELDS = [
        {"fieldname": "tenantGuid", "fieldchinesename": "租户标识", "fieldtype": "nvarchar", "fieldlength": "50", "ordernumingrid": "11"},
        {"fieldname": "operatedate", "fieldchinesename": "操作日期", "fieldtype": "datetime", "fieldlength": "", "ordernumingrid": "10"},
        {"fieldname": "operateuserbaseouguid", "fieldchinesename": "操作人所在独立部门Guid", "fieldtype": "nvarchar", "fieldlength": "50", "ordernumingrid": "9"},
        {"fieldname": "belongxiaqucode", "fieldchinesename": "所属辖区编号", "fieldtype": "nvarchar", "fieldlength": "50", "ordernumingrid": "8"},
        {"fieldname": "rowguid", "fieldchinesename": "主键guid", "fieldtype": "nvarchar", "fieldlength": "50", "ordernumingrid": "7"},
        {"fieldname": "operateuserouguid", "fieldchinesename": "操作人所在部门Guid", "fieldtype": "nvarchar", "fieldlength": "50", "ordernumingrid": "6", "isFrameOu": "true"},
        {"fieldname": "row_id", "fieldchinesename": "序号", "fieldtype": "Integer", "fieldlength": "", "ordernumingrid": "5", "autoIncrease": "true"},
        {"fieldname": "operateusername", "fieldchinesename": "操作人姓名", "fieldtype": "nvarchar", "fieldlength": "50", "ordernumingrid": "4"},
        {"fieldname": "yearflag", "fieldchinesename": "年份标识", "fieldtype": "nvarchar", "fieldlength": "50", "ordernumingrid": "3"},
        {"fieldname": "operateuserguid", "fieldchinesename": "操作人Guid", "fieldtype": "nvarchar", "fieldlength": "50", "ordernumingrid": "2", "isFrameUser": "true"},
        {"fieldname": "pviguid", "fieldchinesename": "流程标识", "fieldtype": "nvarchar", "fieldlength": "50", "ordernumingrid": "1"},
    ]

    def __init__(self):
        self.used_guids = set()
        self.field_id_counter = 900

    def generate_guid(self):
        guid = str(uuid.uuid4())
        while guid in self.used_guids:
            guid = str(uuid.uuid4())
        self.used_guids.add(guid)
        return guid

    def generate_table_id(self):
        return str(random.randint(10000000, 99999999))

    def generate_table_struct(self, field_info, table_id):
        field_guid = self.generate_guid()
        field_id = str(self.field_id_counter)
        self.field_id_counter += 1
        field_type = field_info["fieldtype"]
        type_map = self.FIELD_TYPE_MAP.get(field_type, self.FIELD_TYPE_MAP["nvarchar"])
        auto_increase = "true" if field_info.get("autoIncrease") == "true" else "false"
        is_frame_ou = "true" if field_info.get("isFrameOu") == "true" else "false"
        is_frame_user = "true" if field_info.get("isFrameUser") == "true" else "false"
        return f"""    <TableStruct>
        <autoIncrease>{auto_increase}</autoIncrease>
        <bak1></bak1>
        <bak2></bak2>
        <bak3></bak3>
        <baseOuGuid></baseOuGuid>
        <basicfieldname></basicfieldname>
        <beforeTableId></beforeTableId>
        <codeID></codeID>
        <columnOrderNum></columnOrderNum>
        <controlwidth>1</controlwidth>
        <customChinesename></customChinesename>
        <customFieldname></customFieldname>
        <customTableId></customTableId>
        <datasource></datasource>
        <datasourceCodename></datasourceCodename>
        <dateFormatType></dateFormatType>
        <defaultvalue></defaultvalue>
        <dispInadd>false</dispInadd>
        <dispfielddesc>false</dispfielddesc>
        <empty>false</empty>
        <fieldGuid>{field_guid}</fieldGuid>
        <fieldNickName></fieldNickName>
        <fieldNumType>{type_map['fieldNumType']}</fieldNumType>
        <fieldchinesename>{field_info['fieldchinesename']}</fieldchinesename>
        <fielddefaultvalue></fielddefaultvalue>
        <fielddesc></fielddesc>
        <fielddisplaytype>{type_map['fielddisplaytype']}</fielddisplaytype>
        <fieldid>{field_id}</fieldid>
        <fieldindex>false</fieldindex>
        <fieldjd></fieldjd>
        <fieldlength>{field_info['fieldlength']}</fieldlength>
        <fieldname>{field_info['fieldname']}</fieldname>
        <fieldnameBasictable></fieldnameBasictable>
        <fieldnameParenttable></fieldnameParenttable>
        <fieldtype>{field_type}</fieldtype>
        <formatType></formatType>
        <frameMj>0</frameMj>
        <gridmultirows>false</gridmultirows>
        <gridwidth></gridwidth>
        <ignoreModifyFlag>false</ignoreModifyFlag>
        <initgetvaluesql></initgetvaluesql>
        <isCustom>false</isCustom>
        <isFrameOu>{is_frame_ou}</isFrameOu>
        <isFrameUser>{is_frame_user}</isFrameUser>
        <isexportexcel>false</isexportexcel>
        <isforeignkey>false</isforeignkey>
        <isorderfield>false</isorderfield>
        <isquerycondition>false</isquerycondition>
        <itemId></itemId>
        <mustfill>false</mustfill>
        <notnull>false</notnull>
        <orderdirection></orderdirection>
        <ordernumingrid>{field_info['ordernumingrid']}</ordernumingrid>
        <sourceTableId></sourceTableId>
        <tableid>{table_id}</tableid>
        <todispingrid>false</todispingrid>
        <uniquefield>false</uniquefield>
        <validcheckformula></validcheckformula>
        <valueurl></valueurl>
        <fieldtypename>{type_map['fieldtypename']}</fieldtypename>
        <datasource_codename></datasource_codename>
        <level>系统</level>
    </TableStruct>"""

    def generate_mis_xml(self, table_comment, sql_table_name, process_guid="", process_name="", business_fields=None):
        table_guid = self.generate_guid()
        table_id = self.generate_table_id()
        xml = f"""<?xml version="1.0" encoding="utf-8"?>
<resultdata>
    <TableBasicInfo>
        <abbreviateName></abbreviateName>
        <addUrl></addUrl>
        <appGuid></appGuid>
        <baseOuGuid></baseOuGuid>
        <basicTableName></basicTableName>
        <detailUrl></detailUrl>
        <dsID></dsID>
        <editUrl></editUrl>
        <empty>false</empty>
        <frameMj>0</frameMj>
        <ignoreModifyFlag>false</ignoreModifyFlag>
        <isEnableOutDs>0</isEnableOutDs>
        <isNianDuTz></isNianDuTz>
        <isOnlineTable></isOnlineTable>
        <isSingleInfo></isSingleInfo>
        <leaderViewUrl></leaderViewUrl>
        <mergeFormIds></mergeFormIds>
        <orderNum>10</orderNum>
        <parentTableId></parentTableId>
        <processGuid>{process_guid}</processGuid>
        <processName>{process_name}</processName>
        <sourceTableName></sourceTableName>
        <sqlTableName>{sql_table_name}</sqlTableName>
        <tableGuid>{table_guid}</tableGuid>
        <tableID>{table_id}</tableID>
        <tableName>{table_comment}</tableName>
        <tableType>0</tableType>
        <usePageType></usePageType>
        <viewName></viewName>
        <viewSql></viewSql>
        <viewornot>数据表</viewornot>
        <_checked>true</_checked>
        <_state>modified</_state>
"""
        self.field_id_counter = 900
        for field in self.DEFAULT_FIELDS:
            xml += self.generate_table_struct(field, table_id) + "\n"
        for i, field in enumerate(business_fields or []):
            xml += self.generate_table_struct({
                "fieldname": field["fieldname"],
                "fieldchinesename": field["fieldchinesename"],
                "fieldtype": field["fieldtype"],
                "fieldlength": field["fieldlength"],
                "ordernumingrid": str(100 + i),
            }, table_id) + "\n"
        xml += """    </TableBasicInfo>
</resultdata>
"""
        return xml, table_guid, table_id


class WorkflowXmlGenerator:
    ACTION_TYPES = {
        "save": "60",
        "submit": "10",
        "approve": "10",
        "reject": "30",
    }

    def __init__(self):
        self.used_guids = set()
        self.activity_guids = {}
        self.operation_guids = {}
        self.vml_id_counter = 2
        self.transition_vml_id_counter = 1
        self.order_num_counter = 20
        self.icon_x_counter = 200

    def generate_guid(self):
        guid = str(uuid.uuid4())
        while guid in self.used_guids:
            guid = str(uuid.uuid4())
        self.used_guids.add(guid)
        return guid

    def now(self):
        return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    def register_activity(self, name, guid):
        self.activity_guids[name] = guid

    def generate_workflow_process(self, process_name):
        process_guid = self.generate_guid()
        current_time = self.now()
        return process_guid, f"""        <WorkflowProcess>
            <appGuid></appGuid>
            <applicationGuid></applicationGuid>
            <canSimpleDisplay></canSimpleDisplay>
            <classId></classId>
            <createDate>{current_time}</createDate>
            <customType></customType>
            <designVersion>senior</designVersion>
            <empty>false</empty>
            <ignoreModifyFlag>false</ignoreModifyFlag>
            <isNewVersion></isNewVersion>
            <note></note>
            <orderNum>50</orderNum>
            <processGuid>{process_guid}</processGuid>
            <processName>{process_name}</processName>
            <processType>10</processType>
            <rowId>0</rowId>
            <stateMachineTag></stateMachineTag>
            <status>10</status>
            <tag>20</tag>
            <tenantGuid></tenantGuid>
            <updateDate>{current_time}</updateDate>
        </WorkflowProcess>"""

    def generate_process_version(self, process_guid, process_name):
        process_version_guid = self.generate_guid()
        author_guid = self.generate_guid()
        current_time = self.now()
        return process_version_guid, f"""            <WorkflowProcessVersion>
                <author>{author_guid}</author>
                <baseOuguid></baseOuguid>
                <classId></classId>
                <copyFromProcessVersionGuid></copyFromProcessVersionGuid>
                <createDate>{current_time}</createDate>
                <defaultUserGuid></defaultUserGuid>
                <deleteAppInstanceMethodGuid></deleteAppInstanceMethodGuid>
                <designContent></designContent>
                <designVersion>senior</designVersion>
                <direction>90</direction>
                <earlyWarningTime></earlyWarningTime>
                <earlyWarningTimeUnit>50</earlyWarningTimeUnit>
                <empty>false</empty>
                <ignoreModifyFlag>false</ignoreModifyFlag>
                <instanceNameExpression></instanceNameExpression>
                <isLogMisTableValues>20</isLogMisTableValues>
                <isShowLineGraph>Normal</isShowLineGraph>
                <isShowNodeSimple>details</isShowNodeSimple>
                <mobileMessageTag></mobileMessageTag>
                <noParticipatorOption></noParticipatorOption>
                <note></note>
                <notifyRealizeType></notifyRealizeType>
                <participatorIsInitiatorOption></participatorIsInitiatorOption>
                <participatorisInitiatorOption></participatorisInitiatorOption>
                <processGuid>{process_guid}</processGuid>
                <processVersionGuid>{process_version_guid}</processVersionGuid>
                <processVersionName>{process_name}</processVersionName>
                <revokeAllowDay></revokeAllowDay>
                <revokeOption></revokeOption>
                <revokeRemindOption></revokeRemindOption>
                <rowId>0</rowId>
                <status>20</status>
                <tag></tag>
                <tempNum></tempNum>
                <timeLimit></timeLimit>
                <timeLimitUnit>50</timeLimitUnit>
                <type>10</type>
                <updateDate>{current_time}</updateDate>
                <version>V1</version>
                <workItemNameExpression></workItemNameExpression>
            </WorkflowProcessVersion>"""

    def generate_start_activity(self, process_version_guid):
        activity_guid = self.generate_guid()
        current_time = self.now()
        self.register_activity("开始", activity_guid)
        return f"""            <!-- 开始节点 -->
            <Activity>
                <WorkflowActivity>
                    <activityGuid>{activity_guid}</activityGuid>
                    <activityName>开始</activityName>
                    <activityDispName>开始</activityDispName>
                    <activityType>10</activityType>
                    <createDate>{current_time}</createDate>
                    <designVersion>senior</designVersion>
                    <empty>false</empty>
                    <handleUrl></handleUrl>
                    <iconX>50</iconX>
                    <iconY>200</iconY>
                    <orderNum>10</orderNum>
                    <processVersionGuid>{process_version_guid}</processVersionGuid>
                    <rowId>0</rowId>
                    <splitType>30</splitType>
                    <updateDate>{current_time}</updateDate>
                    <vmlId>1</vmlId>
                </WorkflowActivity>
                <paticipator></paticipator>
            </Activity>"""

    def generate_end_activity(self, process_version_guid, icon_x):
        activity_guid = self.generate_guid()
        current_time = self.now()
        self.register_activity("结束", activity_guid)
        return f"""            <!-- 结束节点 -->
            <Activity>
                <WorkflowActivity>
                    <activityGuid>{activity_guid}</activityGuid>
                    <activityName>结束</activityName>
                    <activityDispName>结束</activityDispName>
                    <activityType>20</activityType>
                    <createDate>{current_time}</createDate>
                    <designVersion>senior</designVersion>
                    <empty>false</empty>
                    <handleUrl></handleUrl>
                    <iconX>{icon_x}</iconX>
                    <iconY>200</iconY>
                    <joinType>30</joinType>
                    <orderNum>99</orderNum>
                    <processVersionGuid>{process_version_guid}</processVersionGuid>
                    <rowId>0</rowId>
                    <updateDate>{current_time}</updateDate>
                    <vmlId>-1</vmlId>
                </WorkflowActivity>
                <paticipator></paticipator>
            </Activity>"""

    def generate_normal_activity(self, process_version_guid, activity_name, operations=None, handle_url=""):
        activity_guid = self.generate_guid()
        current_time = self.now()
        self.register_activity(activity_name, activity_guid)
        vml_id = self.vml_id_counter
        self.vml_id_counter += 1
        order_num = self.order_num_counter
        self.order_num_counter += 10
        icon_x = self.icon_x_counter
        self.icon_x_counter += 150
        operations_xml = ""
        for i, op in enumerate(operations or []):
            op_guid = self.generate_guid()
            operation_key = _first(op.get("operationKey"), op.get("key"), f"{activity_name}_{i}")
            self.operation_guids[operation_key] = op_guid
            op["operationGuid"] = op_guid
            semantic = _as_text(op.get("semantic"))
            operation_type = _as_text(op.get("operationType"), self.ACTION_TYPES.get(semantic, ""))
            if not semantic or semantic not in self.ACTION_TYPES:
                raise ArtifactError(f"workflow action semantic is required: {activity_name}/{op.get('name', '')}")
            if not operation_type:
                raise ArtifactError(f"workflow action type is missing: {activity_name}/{op.get('name', '')}")
            target_activity = _as_text(op.get("targetActivity"))
            if semantic == "reject" and target_activity in ("", "previous", "before"):
                target_activity = "[#=AllBeforeActivity#]"
            check_material_submit = _as_text(op.get("checkMaterialSubmit"), "20")
            requires_opinion = "10" if op.get("requiresOpinion", semantic == "reject") else ""
            operations_xml += f"""                <WorkflowActivityOperation>
                    <activityGuid>{activity_guid}</activityGuid>
                    <backTargetScope></backTargetScope>
                    <controlVisiableMethodGuid></controlVisiableMethodGuid>
                    <inputInfo></inputInfo>
                    <allowModifyActivity>10</allowModifyActivity>
                    <allowModifyTransactor>10</allowModifyTransactor>
                    <empty>false</empty>
                    <iconX>0</iconX>
                    <iconY>0</iconY>
                    <is_ShowNextActivity>{op.get('is_ShowNextActivity', 'true')}</is_ShowNextActivity>
                    <is_ShowOperationPage>{op.get('is_ShowOperationPage', 'true')}</is_ShowOperationPage>
                    <is_ShowOpinionTemplete>false</is_ShowOpinionTemplete>
                    <isCheckMaterialSubmit>{check_material_submit}</isCheckMaterialSubmit>
                    <isRequireOpinion>{requires_opinion}</isRequireOpinion>
                    <note></note>
                    <operationGuid>{op_guid}</operationGuid>
                    <operationName>{op.get('name', '')}</operationName>
                    <operationType>{operation_type}</operationType>
                    <operationVisiableCase>{op.get('operationVisiableCase', '1020')}</operationVisiableCase>
                    <orderNum>{10 + i * 10}</orderNum>
                    <processVersionGuid>{process_version_guid}</processVersionGuid>
                    <rowId>0</rowId>
                    <targetActivity>{target_activity}</targetActivity>
                </WorkflowActivityOperation>
"""
        return icon_x, f"""            <!-- {activity_name}节点 -->
            <Activity>
                <WorkflowActivity>
                    <activityGuid>{activity_guid}</activityGuid>
                    <activityName>{activity_name}</activityName>
                    <activityDispName>{activity_name}</activityDispName>
                    <activityType>30</activityType>
                    <createDate>{current_time}</createDate>
                    <designVersion>senior</designVersion>
                    <empty>false</empty>
                    <handleUrl>{handle_url}</handleUrl>
                    <iconX>{icon_x}</iconX>
                    <iconY>200</iconY>
                    <joinType>30</joinType>
                    <multiTransactorMode>10</multiTransactorMode>
                    <orderNum>{order_num}</orderNum>
                    <processVersionGuid>{process_version_guid}</processVersionGuid>
                    <rowId>0</rowId>
                    <splitType>20</splitType>
                    <updateDate>{current_time}</updateDate>
                    <vmlId>{vml_id}</vmlId>
                </WorkflowActivity>
                <autoInsertPassBtn>true</autoInsertPassBtn>
                <isSendToMessageCenter>10</isSendToMessageCenter>
                <paticipator></paticipator>
{operations_xml}            </Activity>"""

    def generate_external_methods(self, process_version_guid, operation_events, type_name):
        events_xml = ""
        generated = []
        for event in operation_events or []:
            if not isinstance(event, dict) or _as_text(event.get("mode")).lower() != "service_method":
                continue
            operation_key = _as_text(event.get("operationKey"))
            source_guid = self.operation_guids.get(operation_key)
            if not source_guid:
                raise ArtifactError(f"workflow event references unknown operationKey: {operation_key}")
            method_name = _as_text(event.get("methodName"))
            if not method_name or not type_name:
                raise ArtifactError(f"workflow external method target is incomplete: {operation_key}")
            method_guid = self.generate_guid()
            event_guid = self.generate_guid()
            parameters = [item for item in _array(event.get("parameters")) if isinstance(item, dict)]
            for parameter_index, parameter in enumerate(parameters):
                parameter_source = _as_text(parameter.get("source"))
                parameter_value = _as_text(parameter.get("value"))
                if parameter_source == "$PVI_GUID":
                    if parameter_value:
                        raise ArtifactError(
                            f"workflow parameter $PVI_GUID must not carry a custom value: {operation_key}/{parameter_index}"
                        )
                    continue
                if parameter_source != "constant" or not ASCII_STABLE_CONSTANT_PATTERN.fullmatch(parameter_value):
                    raise ArtifactError(
                        f"workflow parameter source/value is invalid: {operation_key}/{_as_text(parameter.get('name'))}"
                    )
            dll_path = "".join(
                f"[java.lang.String][{_as_text(parameter.get('name'))}][{_as_text(parameter.get('description'))}]"
                for parameter in parameters
            )
            events_xml += f"""        <WorkflowEvent>
            <baseOuguid></baseOuguid>
            <belongTo>22</belongTo>
            <empty>false</empty>
            <eventGuid>{event_guid}</eventGuid>
            <eventMethodGuid>{method_guid}</eventMethodGuid>
            <eventName>操作后业务：{_as_text(event.get('operationName'), method_name)}</eventName>
            <eventType>55</eventType>
            <ignoreModifyFlag>false</ignoreModifyFlag>
            <note>{_as_text(event.get('businessEffect'))}</note>
            <orderNumber>100</orderNumber>
            <processVersionGuid>{process_version_guid}</processVersionGuid>
            <realizeType></realizeType>
            <sourceGuid>{source_guid}</sourceGuid>
            <syncType>0</syncType>
            <transitionGuid></transitionGuid>
        </WorkflowEvent>
        <Method>
            <WorkflowMethod>
                <activityGuid></activityGuid>
                <belongTo>0</belongTo>
                <dllPath>{dll_path}</dllPath>
                <empty>false</empty>
                <ignoreModifyFlag>false</ignoreModifyFlag>
                <isLog></isLog>
                <methodGuid>{method_guid}</methodGuid>
                <methodName>{method_name}</methodName>
                <note>{_as_text(event.get('businessEffect'))}</note>
                <orderNum>0</orderNum>
                <processVersionGuid>{process_version_guid}</processVersionGuid>
                <returnValueType>String</returnValueType>
                <ruleGuid></ruleGuid>
                <typeName>{type_name}</typeName>
                <is_log></is_log>
            </WorkflowMethod>
"""
            for parameter in parameters:
                parameter_name = _as_text(parameter.get("name"))
                parameter_source = _as_text(parameter.get("source"))
                parameter_value = _as_text(parameter.get("value"))
                if parameter_source == "$PVI_GUID":
                    parameter_value = "[#=ProcessVersionInstance_ProcessVersionInstanceGuid#]"
                events_xml += f"""            <WorkflowMethodParameter>
                <empty>false</empty>
                <encrypt>0</encrypt>
                <fieldGuid></fieldGuid>
                <ignoreModifyFlag>false</ignoreModifyFlag>
                <methodGuid>{method_guid}</methodGuid>
                <mpNameDescription>{_as_text(parameter.get('description'))}</mpNameDescription>
                <mpValueDescription>{'标识' if parameter_source == '$PVI_GUID' else ''}</mpValueDescription>
                <mpguid>{self.generate_guid()}</mpguid>
                <mpname>{parameter_name}</mpname>
                <mptype>10</mptype>
                <mpvalue>{parameter_value}</mpvalue>
                <orderNum>0</orderNum>
                <processVersionGuid>{process_version_guid}</processVersionGuid>
            </WorkflowMethodParameter>
"""
            events_xml += "        </Method>\n"
            generated.append({
                "operationKey": operation_key,
                "sourceGuid": source_guid,
                "eventGuid": event_guid,
                "eventMethodGuid": method_guid,
                "methodGuid": method_guid,
                "methodName": method_name,
                "typeName": type_name,
                "parameters": parameters,
            })
        return events_xml, generated

    def generate_transition(self, process_version_guid, from_name, to_name, condition=""):
        from_guid = self.activity_guids.get(from_name)
        to_guid = self.activity_guids.get(to_name)
        if not from_guid or not to_guid:
            raise ArtifactError(f"transition references unknown activity: {from_name} -> {to_name}")
        transition_guid = self.generate_guid()
        vml_id = self.transition_vml_id_counter
        self.transition_vml_id_counter += 1
        name = condition or to_name
        return f"""            <!-- 转移连线: {from_name} -> {to_name} -->
            <Transition>
                <WorkflowTransition>
                    <empty>false</empty>
                    <fromActivityGuid>{from_guid}</fromActivityGuid>
                    <fromPort>null</fromPort>
                    <isDefault>20</isDefault>
                    <isSendToMessageCenter>10</isSendToMessageCenter>
                    <isShowAsOperationButton>20</isShowAsOperationButton>
                    <isTargetTransactorEditable>10</isTargetTransactorEditable>
                    <orderNum>60</orderNum>
                    <point>null</point>
                    <priority>60</priority>
                    <processVersionGuid>{process_version_guid}</processVersionGuid>
                    <rowId>0</rowId>
                    <targetActivityTransactorSource>10</targetActivityTransactorSource>
                    <toActivityGuid>{to_guid}</toActivityGuid>
                    <toPort>null</toPort>
                    <transitionDispName>{name}</transitionDispName>
                    <transitionGuid>{transition_guid}</transitionGuid>
                    <transitionName>{name}</transitionName>
                    <type>10</type>
                    <vmlId>{vml_id}</vmlId>
                </WorkflowTransition>
            </Transition>"""

    def generate_workflow_xml(self, process_name, activities, transitions, operation_events=None, type_name=""):
        process_guid, process_xml = self.generate_workflow_process(process_name)
        process_version_guid, version_xml = self.generate_process_version(process_guid, process_name)
        activities_xml = self.generate_start_activity(process_version_guid) + "\n"
        last_icon_x = 200
        for activity in activities:
            icon_x, activity_xml = self.generate_normal_activity(
                process_version_guid,
                activity["name"],
                activity.get("operations"),
                activity.get("handleUrl", ""),
            )
            activities_xml += activity_xml + "\n"
            last_icon_x = icon_x
        activities_xml += self.generate_end_activity(process_version_guid, last_icon_x + 150) + "\n"
        external_methods_xml, generated_methods = self.generate_external_methods(
            process_version_guid,
            operation_events,
            type_name,
        )
        transitions_xml = ""
        for transition in transitions:
            transitions_xml += self.generate_transition(
                process_version_guid,
                transition["from"],
                transition["to"],
                transition.get("condition", ""),
            ) + "\n"
        xml = f"""<?xml version="1.0" encoding="utf-8"?>
<resultdata>
    <WorkFlow>
{process_xml}
        <WorkFlowVersion>
{version_xml}
{activities_xml}{external_methods_xml}{transitions_xml}        </WorkFlowVersion>
    </WorkFlow>
</resultdata>
"""
        return xml, process_guid, process_version_guid, generated_methods


def _business_fields(columns):
    fields = []
    seen = {item["fieldname"].lower() for item in MisXmlGenerator.DEFAULT_FIELDS}
    for column in columns:
        if not isinstance(column, dict):
            continue
        name = _first(column.get("name"), column.get("fieldname"), column.get("columnName"))
        if not name or name.lower() in seen:
            continue
        seen.add(name.lower())
        field_type = _normalize_sql_type(column.get("type") or column.get("fieldtype"))
        fields.append({
            "fieldname": name,
            "fieldchinesename": _first(column.get("comment"), column.get("fieldchinesename"), name),
            "fieldtype": field_type,
            "fieldlength": _normalize_field_length(field_type, column.get("length") or column.get("fieldlength")),
        })
    return fields


def _normalize_operation(operation):
    if isinstance(operation, str):
        operation = {"name": operation}
    if not isinstance(operation, dict):
        operation = {"name": _as_text(operation)}
    name = _first(operation.get("operationName"), operation.get("name"), operation.get("label"))
    operation_key = _first(operation.get("operationKey"), operation.get("key"))
    semantic = _first(operation.get("semantic"), operation.get("actionType"), operation.get("type")).lower()
    if not semantic:
        if "保存" in name:
            semantic = "save"
        elif "提交" in name or "申请" in name:
            semantic = "submit"
        elif "驳回" in name or "不通过" in name or "退回" in name or "拒绝" in name:
            semantic = "reject"
        elif "通过" in name or "同意" in name or "办结" in name:
            semantic = "approve"
    if "通过" in name and ("驳回" in name or "不通过" in name):
        return [
            {"name": "审核通过", "semantic": "approve"},
            {"name": "审核不通过", "semantic": "reject", "targetActivity": "previous", "requiresOpinion": True}
        ]
    # 有显式 key 但推断不出 semantic 的操作，默认 submit（工作流最常见的推进动作）。
    # 无 key 且推断不出的旧合同操作直接丢弃。
    if semantic not in WorkflowXmlGenerator.ACTION_TYPES:
        if operation_key:
            semantic = "submit"
        else:
            return None
    out = {
        "name": name,
        "semantic": semantic,
        "operationKey": _first(operation.get("operationKey"), operation.get("key")),
    }
    for key in ("operationType", "is_ShowNextActivity", "is_ShowOperationPage", "operationVisiableCase", "targetActivity", "target"):
        if key in operation:
            normalized_key = "targetActivity" if key == "target" else key
            out[normalized_key] = _as_text(operation.get(key))
    if operation.get("requiresOpinion") is True or operation.get("isRequireOpinion") is True:
        out["requiresOpinion"] = True
    if operation.get("checkMaterialSubmit") is True or operation.get("isCheckMaterialSubmit") is True:
        out["checkMaterialSubmit"] = "20"
    return out


def _normalize_operations(values):
    result = []
    for value in _array(values):
        normalized = _normalize_operation(value)
        if isinstance(normalized, list):
            result.extend(normalized)
        elif normalized:
            result.append(normalized)
    return result


def _canonicalize_workflow(activities, transitions):
    activities = [dict(item) for item in activities]
    transitions = [dict(item) for item in transitions]
    activity_by_key = {item["key"]: item for item in activities}
    activity_by_name = {item["name"]: item for item in activities}
    # Legacy contracts modeled “驳回修改再提交” as a node. In the Epoint model
    # this is the reject action on the review node, returning to the previous node.
    legacy_reject_nodes = [item for item in activities if "驳回" in item["name"] and "再提交" in item["name"]]
    for legacy in legacy_reject_nodes:
        activities.remove(legacy)
        transitions = [item for item in transitions if item["from"] != legacy["key"] and item["to"] != legacy["key"]]
    for activity in activities:
        expanded = _normalize_operations(activity.get("operations"))
        if legacy_reject_nodes and "审核" in activity["name"] and not any(op.get("semantic") == "reject" for op in expanded):
            expanded.append({"name": "审核不通过", "semantic": "reject", "targetActivity": "previous", "requiresOpinion": True})
        activity["operations"] = expanded
    # Unconditioned back edges to the immediate predecessor are represented by
    # the reject action, not by a second transition. Keep explicitly conditioned
    # legacy transitions because they carry an intentional business branch.
    predecessor = {}
    for item in transitions:
        if item.get("condition"):
            continue
        predecessor.setdefault(item["to"], item["from"])
    filtered = []
    for item in transitions:
        source = activity_by_key.get(item["from"]) or activity_by_name.get(item["from"])
        target = activity_by_key.get(item["to"]) or activity_by_name.get(item["to"])
        if not item.get("condition") and source and target and "审核" in source["name"] and predecessor.get(item["from"]) == item["to"]:
            if any(op.get("semantic") == "reject" for op in source.get("operations", [])):
                continue
        filtered.append(item)
    unique = []
    seen = set()
    for item in filtered:
        key = (item.get("from", ""), item.get("to", ""), item.get("condition", ""))
        if key in seen:
            continue
        seen.add(key)
        unique.append(item)
    return activities, unique


def _validate_workflow_xml(path, expected_activities, expected_transitions, expected_methods=None):
    try:
        root = ET.parse(path).getroot()
    except Exception as error:
        raise ArtifactError(f"workflow XML 解析失败：{error}")
    activities = root.findall('.//Activity/WorkflowActivity')
    transitions = root.findall('.//Transition/WorkflowTransition')
    if len(activities) != len(expected_activities) + 2:
        raise ArtifactError(f"workflow XML 节点数量不匹配：期望 {len(expected_activities) + 2}，实际 {len(activities)}")
    if len(transitions) != len(expected_transitions):
        raise ArtifactError(f"workflow XML 连线数量不匹配：期望 {len(expected_transitions)}，实际 {len(transitions)}")
    activity_guids = {item.findtext('activityGuid', '') for item in activities}
    for transition in transitions:
        if transition.findtext('fromActivityGuid', '') not in activity_guids or transition.findtext('toActivityGuid', '') not in activity_guids:
            raise ArtifactError('workflow XML 连线引用了不存在的活动节点')
    for operation in root.findall('.//WorkflowActivityOperation'):
        operation_type = operation.findtext('operationType', '')
        name = operation.findtext('operationName', '')
        if operation_type not in WorkflowXmlGenerator.ACTION_TYPES.values():
            raise ArtifactError(f"workflow XML 操作类型非法：{name}/{operation_type}")
        if operation_type == '30' and not operation.findtext('targetActivity', ''):
            raise ArtifactError(f"workflow XML 驳回动作缺少 targetActivity：{name}")
    workflow_events = root.findall('.//WorkflowEvent')
    workflow_methods = root.findall('.//Method/WorkflowMethod')
    workflow_parameters = root.findall('.//Method/WorkflowMethodParameter')
    method_by_guid = {
        item.findtext('methodGuid', ''): item
        for item in workflow_methods
        if item.findtext('methodGuid', '')
    }
    operation_guids = {
        item.findtext('operationGuid', '')
        for item in root.findall('.//WorkflowActivityOperation')
        if item.findtext('operationGuid', '')
    }
    expected_methods = expected_methods or []
    if len(workflow_events) != len(expected_methods):
        raise ArtifactError(f"workflow XML 外部事件数量不匹配：期望 {len(expected_methods)}，实际 {len(workflow_events)}")
    for expected in expected_methods:
        source_guid = expected.get('sourceGuid', '')
        method_guid = expected.get('eventMethodGuid', '')
        if source_guid not in operation_guids:
            raise ArtifactError(f"workflow XML 外部事件 sourceGuid 未引用操作：{source_guid}")
        if method_guid not in method_by_guid:
            raise ArtifactError(f"workflow XML 外部事件 eventMethodGuid 未引用 WorkflowMethod：{method_guid}")
        event = next((item for item in workflow_events if item.findtext('eventMethodGuid', '') == method_guid), None)
        if event is None or event.findtext('eventType', '') != '55' or event.findtext('sourceGuid', '') != source_guid:
            raise ArtifactError(f"workflow XML 外部事件引用不完整：{expected.get('operationKey', '')}")
        method = method_by_guid[method_guid]
        if method.findtext('methodName', '') != expected.get('methodName', ''):
            raise ArtifactError(f"workflow XML 外部方法名不一致：{expected.get('operationKey', '')}")
        if method.findtext('typeName', '') != expected.get('typeName', ''):
            raise ArtifactError(f"workflow XML 外部方法类路径不一致：{expected.get('operationKey', '')}")
        actual_parameters = [
            item for item in workflow_parameters
            if item.findtext('methodGuid', '') == method_guid
        ]
        expected_parameters = expected.get('parameters') or []
        if [item.findtext('mpname', '') for item in actual_parameters] != [
            _as_text(item.get('name')) for item in expected_parameters
        ]:
            raise ArtifactError(f"workflow XML 外部方法参数名不一致：{expected.get('operationKey', '')}")
    return True


def _node_name(value, activities_by_key):
    text = _as_text(value)
    lowered = text.lower()
    if lowered in ("start", "begin"):
        return "开始"
    if lowered in ("end", "finish"):
        return "结束"
    if text in activities_by_key:
        return activities_by_key[text]
    return text


def _workflow_payload(contract):
    process_name = _first(contract.get("processName"), contract.get("name"), "工作流")
    activities = []
    activities_by_key = {}
    for item in _array(contract.get("activities")):
        if not isinstance(item, dict):
            continue
        name = _first(item.get("name"), item.get("activityName"), item.get("key"))
        if not name:
            continue
        key = _first(item.get("key"), item.get("id"), name)
        activities_by_key[key] = name
        activities_by_key[name] = name
        activities.append({
            "key": key,
            "name": name,
            "handleUrl": _first(item.get("handleUrl"), item.get("pageUrl")),
            # Keep the authored action objects intact until canonicalization;
            # normalizing twice would expand a legacy “通过或驳回” action twice.
            "operations": _array(item.get("operations")),
        })
    if not activities:
        raise ArtifactError("workflowContract.activities is required")

    transitions = []
    legacy_reject_refs = {
        ref for item in activities
        if "驳回" in item["name"] and "再提交" in item["name"]
        for ref in (item["key"], item["name"])
    }
    for item in _array(contract.get("transitions")):
        if not isinstance(item, dict):
            continue
        raw_from = _first(item.get("from"), item.get("fromActivity"), item.get("source"))
        raw_to = _first(item.get("to"), item.get("toActivity"), item.get("target"))
        if raw_from in legacy_reject_refs or raw_to in legacy_reject_refs:
            continue
        from_name = _node_name(raw_from, activities_by_key)
        to_name = _node_name(raw_to, activities_by_key)
        if not from_name or not to_name:
            continue
        transitions.append({
            "from": from_name,
            "to": to_name,
            "condition": _first(item.get("condition"), item.get("name"), item.get("label")),
        })
    if not transitions:
        raise ArtifactError("workflowContract.transitions is required")
    return (
        process_name,
        *(_canonicalize_workflow(activities, transitions)),
        _array(contract.get("operationEvents")),
        _first(contract.get("serviceInternalTypeName")),
    )


def generate(packet):
    normalized = _extract_packet(packet)
    output_dir = os.path.join(normalized["outputRoot"], normalized["bizModule"])
    mis_path = os.path.join(output_dir, f"{normalized['bizModule']}-mis.xml")
    workflow_path = os.path.join(output_dir, f"{normalized['bizModule']}-workflow.xml")

    process_name, activities, transitions, operation_events, contract_type_name = _workflow_payload(normalized["workflowContract"])
    operation_events = operation_events or normalized["workflowContract"].get("operationEvents", [])
    type_name = _first(normalized.get("serviceInternalTypeName"), contract_type_name)
    default_handle_url = f"perpage/{normalized['bizModule']}/gxh{normalized['bizModule']}workflow"
    for activity in activities:
        if not _as_text(activity.get("handleUrl")):
            activity["handleUrl"] = default_handle_url
    wf_gen = WorkflowXmlGenerator()
    workflow_xml, process_guid, process_version_guid, generated_methods = wf_gen.generate_workflow_xml(
        process_name,
        activities,
        transitions,
        operation_events,
        type_name,
    )
    mis_gen = MisXmlGenerator()
    mis_xml, table_guid, table_id = mis_gen.generate_mis_xml(
        normalized["tableComment"],
        normalized["tableName"],
        process_guid,
        process_name,
        _business_fields(normalized["businessColumns"]),
    )

    _write_text(mis_path, mis_xml)
    _write_text(workflow_path, workflow_xml)

    ET.parse(mis_path)
    _validate_workflow_xml(workflow_path, activities, transitions, generated_methods)
    return {
        "generatedAt": datetime.now().isoformat(),
        "bizModule": normalized["bizModule"],
        "tableName": normalized["tableName"],
        "processName": process_name,
        "artifacts": [
            {"artifactKind": "mis_xml", "path": mis_path, "tableGuid": table_guid, "tableID": table_id,
             "activities": activities, "transitions": transitions},
            {"artifactKind": "workflow_xml", "path": workflow_path, "processGuid": process_guid,
             "processVersionGuid": process_version_guid, "activities": activities, "transitions": transitions,
             "workflowExternalMethodSeeds": normalized["workflowExternalMethodSeeds"],
             "serviceInternalTypeName": type_name, "workflowExternalMethods": generated_methods},
        ],
    }


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="workflow task packet JSON path")
    args = parser.parse_args(argv)
    try:
        result = generate(_read_json(args.input))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1
    touched_files = [item["path"] for item in result["artifacts"]]
    coverage_checklist = [
        {"item": item["artifactKind"], "status": "done", "evidence": item["path"]}
        for item in result["artifacts"]
    ]
    print(json.dumps({
        "ok": True,
        "result": result,
        "touchedFiles": touched_files,
        "summary": f"已生成 {result['processName']} 的 MIS/workflow XML 辅助产物。",
        "coverageChecklist": coverage_checklist
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
