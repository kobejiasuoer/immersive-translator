#!/usr/bin/env bash
# 一键打印专家团提示词，方便复制到任意 AI 的对话框
# 用法：bash docs/print-review-prompt.sh

DOC="D:/workspace/immersive-translator/docs/expert-team-review-prompt-template.md"

if [ ! -f "$DOC" ]; then
  echo "找不到模板文件：$DOC"
  exit 1
fi

echo "==============================================="
echo " 专家团审查提示词模板"
echo "==============================================="
echo ""
echo "打开下面这个文件，把【第一部分】整段复制给 AI："
echo "  $DOC"
echo ""
echo "（Windows 上可用 notepad \"$DOC\" 直接打开）"
echo ""
echo "替换 4 处【】里的内容："
echo "  1. 审查的模块名"
echo "  2. 项目类型"
echo "  3. 审查目标目录"
echo "  4. 关键代码位置 / 产品定位 / 用户痛点 / 既有设计决策"
echo ""
echo "==============================================="
echo " 可选：直接查看第一部分"
echo "==============================================="

# 提取第一部分（到第二部分之前）
if command -v sed >/dev/null 2>&1; then
  sed -n '/^## 第一部分/,/^## 第二部分/p' "$DOC" | head -n -1
fi