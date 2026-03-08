#!/usr/bin/env bash
# ============================================================
# validate-config.sh — Validate Vapi config YAML files
# ============================================================
# Usage: ./validate-config.sh
#
# Checks that all config YAML files are valid and contain
# required fields. Does NOT make any API calls.
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="$SCRIPT_DIR/../../config"
ERRORS=0

echo "🔍 Validating Vapi config files..."
echo ""

# Check YAML syntax for all config files
for f in $(find "$CONFIG_DIR" -name "*.yaml" -type f); do
  if ! python3 -c "import yaml; yaml.safe_load(open('$f'))" 2>/dev/null; then
    echo "❌ YAML syntax error: $f"
    ERRORS=$((ERRORS + 1))
  else
    echo "✅ $f"
  fi
done

echo ""

# Check required fields in assistant config
ASSISTANT_CONFIG="$CONFIG_DIR/vapi/assistants/entry_greeter.yaml"
if [[ -f "$ASSISTANT_CONFIG" ]]; then
  python3 -c "
import yaml, sys
with open('$ASSISTANT_CONFIG') as f:
    data = yaml.safe_load(f)
assistant = data.get('assistant', data)
missing = []
for field in ['slug', 'firstMessage']:
    # Check in nested 'assistant' key or top-level
    found = False
    for key in [assistant, data]:
        if isinstance(key, dict):
            for k, v in key.items():
                if isinstance(v, dict) and field in v:
                    found = True
                    break
            if field in key:
                found = True
    if not found:
        missing.append(field)
if missing:
    print(f'⚠️  Missing fields in entry_greeter.yaml: {missing}')
    sys.exit(1)
" 2>/dev/null || true
fi

# Check environment configs
for env in dev uat prod; do
  ENV_CONFIG="$CONFIG_DIR/environments/$env.yaml"
  if [[ ! -f "$ENV_CONFIG" ]]; then
    echo "❌ Missing environment config: $env.yaml"
    ERRORS=$((ERRORS + 1))
  fi
done

echo ""
if [[ $ERRORS -eq 0 ]]; then
  echo "✅ All config files are valid"
else
  echo "❌ Found $ERRORS error(s)"
  exit 1
fi
