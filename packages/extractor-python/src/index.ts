/**
 * `@meridian/extractor-python` — the stdlib-ast `LanguageExtractor`.
 *
 * Spawns `python/analyze.py` to read a Python tree, then maps its modules/nodes/edges into the
 * `@meridian/core` graph model; the CLI wraps them in an artifact header. Register
 * `createPythonExtractor()` (or `new PythonExtractor()`) with core's `ExtractorRegistry`.
 */

export { PythonExtractor, createPythonExtractor } from "./extractor";
