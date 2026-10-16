#!/bin/zsh
cd "${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  print "请先安装 Node.js 22.x：https://nodejs.org/en/download/archive/v22"
  read "?按回车退出"
  exit 1
fi
node scripts/setup.mjs --start
if [[ $? -ne 0 ]]; then
  read "?启动未完成，请查看上面的提示。按回车退出"
fi
