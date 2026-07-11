/**
 * Emit the published JSON Schema (draft 2020-12) from the zod source of truth.
 * Run via `pnpm --filter @meridian/core schema:emit`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { graphArtifactSchema } from "../src/schema";
import { SCHEMA_VERSION } from "../src/types";

const SCHEMA_ID = `https://meridian.dev/schema/graph-artifact/${SCHEMA_VERSION}.json`;

const jsonSchema = z.toJSONSchema(graphArtifactSchema, { target: "draft-2020-12" });
const document = { $id: SCHEMA_ID, title: `Meridian GraphArtifact ${SCHEMA_VERSION}`, ...jsonSchema };

const outputPath = resolve(import.meta.dirname, `../schema/graph-artifact-${SCHEMA_VERSION}.json`);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`);

process.stdout.write(`wrote ${outputPath}\n`);
