# Pinned dependency-isolation fixtures

The unmodified Colorama 0.4.5 and 0.4.6 wheels were retrieved from PyPI during native validation. Their SHA-256 values are fixed in `scripts/verify-dependency-isolation.mjs` and were checked against PyPI release metadata. The wheels include their original license notices; Colorama is BSD licensed.

These are actual packages installed into two different worker-local targets, not mocked package-install results. Keeping the audited bytes makes the isolation regression independent of a new PyPI network request. Missing local fixtures may be downloaded only if the same fixed digest is satisfied.

Original retrieval receipts: `validation/dependency-isolation-9a058171-82ed-4a33-9182-7390b0462fd6/receipt.json`; public metadata: `https://pypi.org/pypi/colorama/0.4.5/json` and `https://pypi.org/pypi/colorama/0.4.6/json`.
