# Model Behavior and Upstream Inference Verification

Pinned commit: `771d8c07bd5b9f97ada1c551371d5c11ef8d8655`, downloaded 2026-09-09 from https://github.com/LucasCoppens/PromoterAtlas. Upstream files are kept as-is. All 7 weight files are genuine PyTorch checkpoints; source, byte size, and SHA-256 are recorded in `models/manifest.json`.

## Annotation

The original `scripts/annotate.py` runs successfully on CPU. The reference input is taken from the E. coli NC_000913.1 genome bundled with the repository (slice positions are recorded in `scripts/verify-reference.py`), used only to cross-check numerical output against the software, not as an experimental validation of prediction accuracy. The 3 inputs are 200, 230, and 1000 bp respectively, producing 45 windows and 10 window-level elements; this count includes predictions from overlapping windows and should not be read as 10 independent sites.

The model output is a `[batch,12,length]` logits tensor; the original pipeline takes `argmax(dim=1)` along the class dimension. This app displays discrete elements, not pseudo-probabilities. Class 0 is background, 1 is RBS; 2/3 are the -10/-35 elements of σ70/σ38; 4/5 are the -12/-24 elements of σ54; 6/7, 8/9, 10/11 are the -10/-35 elements of σ32, σ28, σ24 respectively. The current annotation weights do not output generic TF-binding-site or terminator labels.

FASTA input is scanned only in the given orientation; the reverse complement is not scanned. Windows are 200 bp with a default step of 20, and the last window always includes the end of the sequence. For a 230 bp sequence the windows are [0,200), [20,220), [30,230). This version restricts the step to 1–200 to guarantee full sequence coverage. Internally, coordinates are 0-based half-open; the UI and table exports add 1 to the start and leave the end unchanged, yielding 1-based, both-ends-inclusive coordinates.

Runs of a label shorter than 3 positions are dropped by default; the co-occurrence rule requires both paired classes to appear within the same window, but does not check biological spacing. Upstream merging, restricted to retained non-background elements, picks position-by-position the prediction farthest from the window edge, breaking ties on center distance by the earliest-occurring window; it is not majority voting and background votes cannot veto an element. The app retains the original windows and records, for each merged element, the overlapping source windows it came from. Upstream merging drops sequences with zero elements; the app adds back an empty record for display purposes without adding any predictions.

## Expression

For all 5 expression models, `fc1.weight` has shape [64,11008], where 11008 = 128 × 86; input must be exactly 86 bp. The upstream implementation left-pads short sequences with zeros within a batch, which can make one sequence's output depend on the rest of its batch; this app always requires exactly 86 bp, with no trimming or padding. The four transcription models come from the datasets identified by their filenames — Lafleur 2022, Hossain 2020, Urtecho 2018, and Yu 2021; the translation model is Kosuri 2013. Each model's output has been cross-checked against the upstream prediction class.

Denormalization follows the checkpoint as-is: `output = raw * std + mean`; only the Kosuri weights set `log_transform=true`, in which case `exp(output)-1` is applied afterward. No additional assumptions are made about the log base or physical units of the transcription models. Each model's mean/std is recorded in the manifest; results use each model's own scale, are not labeled as a.u., and are not compared across models.

## Character Handling and Minimal Adaptation

The original encoding recognizes only uppercase A/C/G/T; every other character, including N and lowercase letters, is encoded as a 4-dimensional zero vector. The upstream annotation entry point uppercases input beforehand; the expression entry point does not. This app preserves the raw input and validation values, and explicitly documents that inference always uppercases input and only allows A/C/G/T/N; N is encoded with the original zero vector, and any other IUPAC code, whitespace, or invalid character is rejected.

PyTorch 2.14 defaults to `weights_only=True`; on first run, the original expression entry point failed because a checkpoint metadata type was not on the allow-list (the full log has been kept). The adaptation only explicitly allow-lists pathlib.PosixPath, numpy.dtype, numpy.core.multiarray.scalar, and the NumPy float64 dtype — it does not disable weights-only loading. `scripts/run-upstream-compatible.py` runs the unmodified upstream script under this allow-list; the reference CSV output was produced successfully.

Upstream's single-sequence `squeeze()` produces a scalar, and `predict_fasta` fails if it iterates that scalar directly. The app calls the original `predict()` and wraps the return value with `np.atleast_1d`; this does not change the numeric values. The original model construction relies on a base-model path relative to the working directory, so the standalone worker only sets the working directory to the packaged upstream directory at construction time.

The upstream issue where `norm_params` is left uninitialized does not occur with the current weights: all 5 checkpoints include `normalization_params`. No upstream code was changed to work around this.

## Verification Evidence

- `tests/artifacts/original-cli-summary.json`: original CLI exit codes, including startup time.
- `reference-annotation.json` / `reference-expression.csv`: genuine reference outputs.
- `adapter-reference.json`: thin-wrapper output; annotation matches exactly, expression matches within an absolute tolerance of 1e-6.
- `reference-genome.gb` / `reference-genome.gff3`: golden outputs from a real *E. coli* NC_000913.1 fragment; the GenBank file uses a display-friendly format with `/label`, while the GFF3 file keeps the upstream format.
- Backend tests: 20 checks, covering all 5 models, single/batch input, end-of-sequence windows, merging, N/lowercase handling, invalid input, the protocol, and byte-for-byte golden comparison of GenBank/GFF3 output.
- `benchmark.json`: local CPU time and peak process RSS. Cold-start/cache conditions may differ between test runs and are not representative of whole-genome performance.

Whole-genome GenBank annotation reuses the upstream `annotate_records` directly. GFF3 output reuses `save_gff3` directly; for GenBank, a `/label` matching `regulatory_class` is added to predicted features before calling `save_genbank`, so downstream software can display element names. GFF3 input, MPS, and other operating systems remain unverified. App limits: 100 records, 250,000 input characters, 5,000 windows.
