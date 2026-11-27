#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""列出模型后端可用的模型。给配置界面用。

读环境变量（Host 注入），输出 JSON 到 stdout。
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)  # lib/ 的上一级 = 插件根目录
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)

try:
    import video_watch as V
except Exception as e:
    print(json.dumps({"ok": False, "models": [], "error": "导入失败：" + str(e)[:200]}, ensure_ascii=False))
    sys.exit(0)


def main():
    result = V.list_models()
    result["provider"] = V.model_provider()
    result["host"] = V.model_base_url()
    result["current"] = V.model_name()
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
