# Reduced skill controls, PR 5051

Current screenshots show f802062. Earlier after screenshots and recordings show
dfe1d9d. Before screenshots show upstream 2b94db847. Keep these labels when linking.
The latest fix changes cold-start ID discovery and error views. Earlier switch,
chat enforcement, JSONC/BOM preservation, conflict and rename tests retain their
recorded revision; they were not all rerun after the discovery fix.

Tests use isolated fixtures on Linux web and unpackaged Electron, with pinned
OpenCode 2.0.29. Earlier API verification also covered 2.0.28. No live VS Code
host, installed desktop or native mobile run is claimed. Non-English locales
were checked by text/parity, not live captures. This evidence is outside the
product branch.
