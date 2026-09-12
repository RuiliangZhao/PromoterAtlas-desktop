# Provenance

Upstream: https://github.com/LucasCoppens/PromoterAtlas
Commit: 771d8c07bd5b9f97ada1c551371d5c11ef8d8655
License: MIT, copyright 2025 Lucas Coppens; unmodified source under vendor/PromoterAtlas.
Weights: all seven files from this commit; SHA-256 in models/manifest.json.
Model validation uses bundled E. coli NC_000913.1.gb slices, not new measurements or training.

No retraining, output rescaling beyond upstream checkpoint normalization, ONNX conversion, MPS or internet service is used. The desktop adapter and UI are new code. Runtime is Python 3.11.16 / PyTorch 2.14.0 / NumPy 1.26.4 (full lock in backend/requirements.lock). Web dependencies are recorded in pnpm-lock.yaml; Rust dependencies in src-tauri/Cargo.lock.

Packaging uses PyInstaller onedir as a fixed executable resource. Rust resolves it from the application's resource directory, controls stdin/stdout JSONL, cancellation and exit cleanup. It exposes no arbitrary shell/path API to the webview. No telemetry, remote model downloads, or network-based prediction are implemented. The application only accesses an external URL when the user explicitly clicks the source-code link.

Tauri documentation consulted during implementation:
- https://v2.tauri.app/develop/sidecar/
- https://v2.tauri.app/reference/config/

Citation: Coppens, L., Ledesma-Amaro, R. "PromoterAtlas: decoding regulatory sequences across Gammaproteobacteria using a transformer model." Nat Commun 17, 6451 (2026). https://doi.org/10.1038/s41467-026-72837-3. Additional notices are in licenses/THIRD_PARTY_NOTICES.txt.
