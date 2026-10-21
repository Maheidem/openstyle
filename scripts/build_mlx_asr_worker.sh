#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="${ROOT_DIR}/.venv-mlx-asr"
DIST_DIR="${ROOT_DIR}/dist"
ARCHIVE_NAME="mlx_asr_worker-darwin-arm64.tar.gz"

PYTHON_BIN="${PYTHON_BIN:-python3.12}"
PYINSTALLER_VERSION="${PYINSTALLER_VERSION:-6.22.3}"
MLX_AUDIO_VERSION="${MLX_AUDIO_VERSION:-0.5.7}"
MLX_VERSION="${MLX_VERSION:-0.32.3}"
MLX_METAL_VERSION="${MLX_METAL_VERSION:-0.32.3}"
HUGGINGFACE_HUB_VERSION="${HUGGINGFACE_HUB_VERSION:-1.33.0}"
# LLM mode (--llm, specs/local-mlx-llm.md section 2): mlx-lm runs the model and llguidance forces
# strict JSON. mlx-lm 0.31.x crashes at import with transformers>=5.14 (mlx-lm#1458); 0.32.0 fixed it.
MLX_LM_VERSION="${MLX_LM_VERSION:-0.32.2}"
LLGUIDANCE_VERSION="${LLGUIDANCE_VERSION:-1.9.1}"
# Embed mode (--embed, specs/local-semantic-search.md 5.2): mlx-vlm loads EmbeddingGemma 2 with
# mlx_vlm.embedding_loader. mlx-vlm 0.7.8 is the last release that accepts mlx 0.32.3 (0.7.9 needs
# mlx>=0.32.4). mlx-embeddings is not used. The PyInstaller excludes below keep the heavy mlx-vlm
# dependencies (pyarrow, opencv, pandas, datasets, the fastapi server stack) out of the bundle: the
# text embedding path imports none of them (#233 bundle measurement, +20 MB tar.gz instead of +111 MB).
MLX_VLM_VERSION="${MLX_VLM_VERSION:-0.7.8}"
# mlx-audio 0.5.x vendors the mlx-lm parts it needs for ASR. LLM mode installs mlx-lm itself (above);
# the pin is past the AutoTokenizer.register crash (ml-explore/mlx-lm#1458, fixed in mlx-lm#1465).
# mlx-audio 0.5.7 requires transformers>=5.14. transformers 5.x requires huggingface_hub<2.0,
# so huggingface_hub stays on the 1.x line (latest 1.33.0).
# mlx-audio 0.5.7 only requires mlx>=0.31.1, so mlx and mlx-metal are pinned here. Unpinned, pip
# keeps whatever mlx an old venv already has (0.31.2 is measurably slower than 0.32.3).
# Any dependency change here must also update MLX_WORKER_BUILD_SPEC in
# apps/server/src/lib/mlx-asr/runtime.ts, or installed workers never re-download.
# A test in apps/server/tests/mlx-runtime.test.ts checks that the two match.
# EmbeddingGemma 2 needs transformers>=5.18 for its tokenizer (#233 spike, check 1).
TRANSFORMERS_SPEC="${TRANSFORMERS_SPEC:->=5.18}"

if ! command -v "${PYTHON_BIN}" >/dev/null 2>&1; then
  echo "Python 3.12 is required to build the MLX ASR worker." >&2
  echo "Install it or set PYTHON_BIN=/path/to/python3.12." >&2
  exit 1
fi

# Always start from a clean venv: pip install keeps already-installed dependency versions,
# so a reused venv silently ships stale packages.
rm -rf "${VENV_DIR}"
"${PYTHON_BIN}" -m venv "${VENV_DIR}"
"${VENV_DIR}/bin/python" -m pip install -U pip
"${VENV_DIR}/bin/python" -m pip install -U \
  "pyinstaller==${PYINSTALLER_VERSION}" \
  "mlx-audio==${MLX_AUDIO_VERSION}" \
  "mlx==${MLX_VERSION}" \
  "mlx-metal==${MLX_METAL_VERSION}" \
  "transformers${TRANSFORMERS_SPEC}" \
  "huggingface_hub[hf_xet]==${HUGGINGFACE_HUB_VERSION}" \
  "mlx-lm==${MLX_LM_VERSION}" \
  "llguidance==${LLGUIDANCE_VERSION}" \
  "mlx-vlm==${MLX_VLM_VERSION}"

rm -rf "${ROOT_DIR}/build/mlx_asr_worker" "${DIST_DIR}/mlx_asr_worker"
"${VENV_DIR}/bin/pyinstaller" \
  --clean \
  --onedir \
  --name mlx_asr_worker \
  --collect-all mlx \
  --collect-all mlx_audio \
  --collect-all huggingface_hub \
  --collect-all mlx_lm \
  --collect-all llguidance \
  --collect-submodules mlx_vlm \
  --exclude-module pyarrow \
  --exclude-module cv2 \
  --exclude-module pandas \
  --exclude-module datasets \
  --exclude-module fastapi \
  --exclude-module uvicorn \
  --exclude-module starlette \
  --exclude-module mlx_embeddings \
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
