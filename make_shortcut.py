#!/usr/bin/env python3
# 生成「开箱即用」版 .shortcut：运行脚本 → 邮件正文直接引用「运行脚本的结果」
import plistlib, gzip, os

OUT = "/workspace/etf-rotator/ETF轮动日报.shortcut"
RUN_UUID = "AAAAAAAA-1111-1111-1111-111111111111"

actions = [
    {
        "WFWorkflowActionIdentifier": "com.scriptable.scriptable.run-script",
        "WFWorkflowActionParameters": {
            "WFScriptName": "ETF Rotator Shortcuts",
            "WFShowResult": False,
            "UUID": RUN_UUID
        }
    },
    {
        "WFWorkflowActionIdentifier": "com.apple.mail.send",
        "WFWorkflowActionParameters": {
            "WFEmailAddress": ["3059402@qq.com"],
            "WFEmailSubject": "【ETF轮动日报】",
            "WFShowComposeSheet": False,
            # 正文直接引用「运行脚本」动作的输出变量
            "WFEmailBody": [
                {
                    "WFTextTokenString": "",
                    "WFTextTokenType": "Variable",
                    "WFTextTokenOutput": True,
                    "WFTextTokenAttachOutput": False,
                    "WFTextTokenVariable": {
                        "Value": {
                            "OutputUUID": RUN_UUID,
                            "OutputName": "运行脚本",
                            "Type": "ActionOutput"
                        },
                        "WFSerializationType": "WFTextTokenVariable"
                    }
                }
            ],
            "UUID": "BBBBBBBB-2222-2222-2222-222222222222"
        }
    }
]

wf = {
    "WFWorkflowName": "ETF轮动日报",
    "WFWorkflowActions": actions,
    "WFWorkflowImportQuestions": [],
    "WFWorkflowTypes": ["Regular"],
    "WFWorkflowClientRelease": "Not specified",
    "WFWorkflowClientVersion": "Not specified",
    "WFWorkflowHasShortcutInput": False,
    "WFWorkflowIcon": {
        "WFWorkflowIconStartColor": 4274264319,
        "WFWorkflowIconGlyphNumber": 59394,
        "WFWorkflowIconImageData": b""
    }
}

data = plistlib.dumps(wf, fmt=plistlib.FMT_BINARY)
with open(OUT, "wb") as f:
    f.write(gzip.compress(data))
print("✅ 已生成:", OUT, "大小", os.path.getsize(OUT), "字节")
