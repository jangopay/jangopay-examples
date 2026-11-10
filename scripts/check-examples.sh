#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

node --check node/payment.mjs
node --check node/ai-credit-topup/src/app.mjs
node --check node/merchant-fulfillment/src/app.mjs
node --test node/ai-credit-topup/test/*.test.mjs
node --test node/merchant-fulfillment/test/*.test.mjs

python3 - <<'PY'
import ast
from pathlib import Path
ast.parse(Path('python/payment.py').read_text(encoding='utf-8'))
print('Python syntax: OK')
PY
php -l php/payment.php
printf '%s\n' 'All local checks passed.'
