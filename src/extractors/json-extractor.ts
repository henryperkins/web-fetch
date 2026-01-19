/**
 * JSON Content Extractor
 *
 * Processes JSON content into a summarized, LLM-friendly format.
 * Avoids dumping huge blobs by providing schema summaries and samples.
 */

import type { ExtractedContent } from '../types.js';

export interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  sample?: unknown;
  count?: number;
  truncated?: boolean;
}

export interface JsonExtractionResult {
  success: boolean;
  content?: ExtractedContent;
  markdown?: string;
  schema?: JsonSchema;
  error?: string;
  warnings: string[];
}

// Limits for summarization
const MAX_OBJECT_KEYS = 20;
const MAX_ARRAY_SAMPLE = 3;
const MAX_STRING_LENGTH = 200;
const MAX_DEPTH = 5;
const MAX_RAW_SIZE = 5000;

/**
 * Extract and summarize JSON content
 */
export function extractJson(
  content: string,
  sourceUrl?: string
): JsonExtractionResult {
  const warnings: string[] = [];

  try {
    const data = JSON.parse(content);

    // Generate schema summary
    const schema = inferSchema(data, 0);

    // Generate markdown representation
    const markdown = generateJsonMarkdown(data, schema, sourceUrl);

    // Generate text content
    const textContent = generateTextSummary(data, schema);

    const extractedContent: ExtractedContent = {
      title: 'JSON Data',
      content: markdown,
      textContent,
      excerpt: textContent.substring(0, 300),
    };

    // Add warnings for large content
    const jsonSize = content.length;
    if (jsonSize > 100000) {
      warnings.push(`Large JSON payload (${Math.round(jsonSize / 1024)}KB) - content has been summarized`);
    }

    return {
      success: true,
      content: extractedContent,
      markdown,
      schema,
      warnings,
    };

  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Invalid JSON',
      warnings,
    };
  }
}

/**
 * Infer a schema-like summary from JSON data
 */
function inferSchema(data: unknown, depth: number): JsonSchema {
  if (depth > MAX_DEPTH) {
    return { type: 'unknown', truncated: true };
  }

  if (data === null) {
    return { type: 'null' };
  }

  if (data === undefined) {
    return { type: 'undefined' };
  }

  const type = typeof data;

  if (type === 'string') {
    const str = data as string;
    return {
      type: 'string',
      sample: str.length > MAX_STRING_LENGTH
        ? str.substring(0, MAX_STRING_LENGTH) + '...'
        : str,
    };
  }

  if (type === 'number' || type === 'boolean') {
    return { type, sample: data };
  }

  if (Array.isArray(data)) {
    const arr = data;
    const schema: JsonSchema = {
      type: 'array',
      count: arr.length,
    };

    if (arr.length > 0) {
      // Sample first few items
      const samples = arr.slice(0, MAX_ARRAY_SAMPLE);
      if (samples.length > 0) {
        // Infer schema from first item
        schema.items = inferSchema(samples[0], depth + 1);
        schema.sample = samples.map(item => summarizeValue(item, depth + 1));
      }

      if (arr.length > MAX_ARRAY_SAMPLE) {
        schema.truncated = true;
      }
    }

    return schema;
  }

  if (type === 'object') {
    const obj = data as Record<string, unknown>;
    const keys = Object.keys(obj);
    const schema: JsonSchema = {
      type: 'object',
      properties: {},
    };

    const keysToProcess = keys.slice(0, MAX_OBJECT_KEYS);

    for (const key of keysToProcess) {
      schema.properties![key] = inferSchema(obj[key], depth + 1);
    }

    if (keys.length > MAX_OBJECT_KEYS) {
      schema.truncated = true;
      schema.count = keys.length;
    }

    return schema;
  }

  return { type: 'unknown' };
}

/**
 * Summarize a value for sampling
 */
function summarizeValue(data: unknown, depth: number): unknown {
  if (depth > 3) {
    return typeof data === 'object' ? '{...}' : data;
  }

  if (data === null || data === undefined) {
    return data;
  }

  const type = typeof data;

  if (type === 'string') {
    const str = data as string;
    return str.length > 100 ? str.substring(0, 100) + '...' : str;
  }

  if (type === 'number' || type === 'boolean') {
    return data;
  }

  if (Array.isArray(data)) {
    if (data.length === 0) return [];
    if (data.length > 3) {
      return [...data.slice(0, 2).map(v => summarizeValue(v, depth + 1)), `... (${data.length - 2} more)`];
    }
    return data.map(v => summarizeValue(v, depth + 1));
  }

  if (type === 'object') {
    const obj = data as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return {};
    if (keys.length > 5) {
      const sample: Record<string, unknown> = {};
      for (const key of keys.slice(0, 3)) {
        sample[key] = summarizeValue(obj[key], depth + 1);
      }
      sample['...'] = `(${keys.length - 3} more keys)`;
      return sample;
    }
    const sample: Record<string, unknown> = {};
    for (const key of keys) {
      sample[key] = summarizeValue(obj[key], depth + 1);
    }
    return sample;
  }

  return data;
}

/**
 * Generate markdown representation of JSON
 */
function generateJsonMarkdown(data: unknown, schema: JsonSchema, sourceUrl?: string): string {
  const lines: string[] = [];

  lines.push('# JSON Data\n');

  if (sourceUrl) {
    lines.push(`Source: ${sourceUrl}\n`);
  }

  lines.push('## Structure\n');
  lines.push(formatSchema(schema, 0));

  lines.push('\n## Sample Data\n');
  lines.push('```json');

  // Create a summarized version of the data
  const summarized = summarizeValue(data, 0);
  const jsonStr = JSON.stringify(summarized, null, 2);

  // Truncate if too large
  if (jsonStr.length > MAX_RAW_SIZE) {
    lines.push(jsonStr.substring(0, MAX_RAW_SIZE));
    lines.push('\n... (truncated)');
  } else {
    lines.push(jsonStr);
  }

  lines.push('```');

  return lines.join('\n');
}

/**
 * Format schema as readable text
 */
function formatSchema(schema: JsonSchema, indent: number): string {
  const prefix = '  '.repeat(indent);
  const lines: string[] = [];

  if (schema.type === 'object' && schema.properties) {
    lines.push(`${prefix}Object {`);
    for (const [key, value] of Object.entries(schema.properties)) {
      lines.push(`${prefix}  "${key}": ${formatSchemaType(value)}`);
    }
    if (schema.truncated) {
      lines.push(`${prefix}  ... (${schema.count} total keys)`);
    }
    lines.push(`${prefix}}`);
  } else if (schema.type === 'array') {
    lines.push(`${prefix}Array[${schema.count ?? 0}] of ${formatSchemaType(schema.items || { type: 'unknown' })}`);
    if (schema.truncated) {
      lines.push(`${prefix}  (showing first ${MAX_ARRAY_SAMPLE} items)`);
    }
  } else {
    lines.push(`${prefix}${formatSchemaType(schema)}`);
  }

  return lines.join('\n');
}

/**
 * Format a schema type as a short string
 */
function formatSchemaType(schema: JsonSchema): string {
  if (schema.type === 'object' && schema.properties) {
    const keys = Object.keys(schema.properties);
    if (keys.length <= 3) {
      return `{ ${keys.join(', ')} }`;
    }
    return `{ ${keys.slice(0, 3).join(', ')}, ... }`;
  }

  if (schema.type === 'array') {
    return `Array[${schema.count ?? '?'}]`;
  }

  if (schema.sample !== undefined && schema.type !== 'object' && schema.type !== 'array') {
    const sampleStr = JSON.stringify(schema.sample);
    if (sampleStr.length < 50) {
      return `${schema.type} (e.g., ${sampleStr})`;
    }
  }

  return schema.type;
}

/**
 * Generate plain text summary
 */
function generateTextSummary(data: unknown, schema: JsonSchema): string {
  const lines: string[] = [];

  lines.push('JSON Data Structure:');

  if (schema.type === 'object' && schema.properties) {
    const keys = Object.keys(schema.properties);
    lines.push(`- Object with ${keys.length}${schema.truncated ? '+' : ''} properties: ${keys.slice(0, 10).join(', ')}${keys.length > 10 ? '...' : ''}`);
  } else if (schema.type === 'array') {
    lines.push(`- Array with ${schema.count ?? 0} items`);
    if (schema.items) {
      lines.push(`- Item type: ${formatSchemaType(schema.items)}`);
    }
  } else {
    lines.push(`- Type: ${schema.type}`);
  }

  return lines.join('\n');
}
