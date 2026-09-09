#!/usr/bin/env bash
# Готовит окружение DeepSeek Harness для запуска Neo pipeline в CI.
# 1. Разворачивает patch-файл с абсолютным путём к настройкам модели.
# 2. Экспортирует BAI_API_KEY из секрета GitHub.
set -euo pipefail

cat > "$RUNNER_TEMP/neo-dsh-patch.yaml" <<EOF
- config:
    path: $GITHUB_WORKSPACE/pipeline/dsh-settings.yaml
  id: settings
EOF

echo "DSH_PATCH=$RUNNER_TEMP/neo-dsh-patch.yaml" >> "$GITHUB_ENV"
echo "BAI_API_KEY=${BAI_API_KEY_SECRET}" >> "$GITHUB_ENV"
echo "Neo: DSH patch и ключ модели настроены"
