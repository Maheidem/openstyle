#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${ROOT_DIR}/.venv-mlx-asr"
DIST_DIR="${ROOT_DIR}/dist"
ARCHIVE_NAME="mlx_asr_worker-darwin-arm64.tar.gz"

PYTHON_BIN="${PYTHON_BIN:-python3.12}"
PYINSTALLER_VERSION="${PYINSTALLER_VERSION:-6.22.3}"
MLX_AUDIO_VERSION="${MLX_AUDIO_VERSION:-0.5.7}"
HUGGINGFACE_HUB_VERSION="${HUGGINGFACE_HUB_VERSION:-1.33.0}"
# mlx-audio 0.5.x vendors the mlx-lm parts it needs, so mlx-lm is no longer installed and the
# AutoTokenizer.register crash (ml-explore/mlx-lm#1458, fixed in mlx-lm#1465) cannot happen.
# mlx-audio 0.5.7 requires transformers>=5.14. transformers 5.x requires huggingface_hub<2.0,
# so huggingface_hub stays on the 1.x line (latest 1.33.0).
# Any dependency change here must also update MLX_WORKER_BUILD_SPEC in
# apps/server/src/lib/mlx-asr/runtime.ts, or installed workers never re-download.
# A test in apps/server/tests/mlx-runtime.test.ts checks that the two match.
TRANSFORMERS_SPEC="${TRANSFORMERS_SPEC:->=5.14}"

if ! command -v "${PYTHON_BIN}" >/dev/null 2>&1; then
  echo "Python 3.12 is required to build the MLX ASR worker." >&2
  echo "Install it or set PYTHON_BIN=/path/to/python3.12." >&2
  exit 1
fi

"${PYTHON_BIN}" -m venv "${VENV_DIR}"
"${VENV_DIR}/bin/python" -m pip install -U pip
"${VENV_DIR}/bin/python" -m pip install -U \
  "pyinstaller==${PYINSTALLER_VERSION}" \
  "mlx-audio==${MLX_AUDIO_VERSION}" \
  "transformers${TRANSFORMERS_SPEC}" \
  "huggingface_hub[hf_xet]==${HUGGINGFACE_HUB_VERSION}"

rm -rf "${ROOT_DIR}/build/mlx_asr_worker" "${DIST_DIR}/mlx_asr_worker"
"${VENV_DIR}/bin/pyinstaller" \
  --clean \
  --onedir \
  --name mlx_asr_worker \
  --collect-all mlx \
  --collect-all mlx_audio \
  --collect-all huggingface_hub \
  --distpath "${DIST_DIR}" \
  --workpath "${ROOT_DIR}/build/mlx_asr_worker" \
  "${ROOT_DIR}/scripts/mlx_asr_server.py"

# PyInstaller emits many nested .dylib/.so files. Without a consistent signature,
# macOS blocks loading libpython (Team ID mismatch), which breaks Qwen in packaged
# builds when electron-builder skips signing (CSC_IDENTITY_AUTO_DISCOVERY=false).
if command -v codesign >/dev/null 2>&1; then
  SIGN_ID="${MLX_ASR_CODESIGN_IDENTITY:--}"
  echo "Signing MLX ASR worker bundle (identity: ${SIGN_ID})"
  codesign --deep --force --sign "${SIGN_ID}" "${DIST_DIR}/mlx_asr_worker"
fi

rm -f "${DIST_DIR}/${ARCHIVE_NAME}"
tar -C "${DIST_DIR}" -czf "${DIST_DIR}/${ARCHIVE_NAME}" mlx_asr_worker

echo "MLX ASR worker archive written to ${DIST_DIR}/${ARCHIVE_NAME}"
