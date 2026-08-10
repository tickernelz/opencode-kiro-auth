import crypto from 'crypto'
import type { ToolNameMap } from '../../plugin/types.js'

export const CODEWHISPERER_TOOL_NAME_MAX_LENGTH = 64
export const CODEWHISPERER_DESCRIPTION_MAX_LENGTH = 1024
export const CODEWHISPERER_SCHEMA_MAX_DEPTH = 32

const SAFE_TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const SUPPORTED_SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'boolean'])

type JsonObject = Record<string, any>

export interface ToolNameRegistry {
  toWire(originalName: string): string
  toOriginalMap(): ToolNameMap
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function truncateCodePoints(value: unknown, limit: number): string {
  if (typeof value !== 'string' || value.length === 0) return ''
  if (value.length <= limit) return value

  let output = ''
  let count = 0
  for (const character of value) {
    if (count >= limit) break
    output += character
    count += 1
  }
  return output
}

function getToolOriginalName(tool: any): string | undefined {
  const directName = tool?.name
  const functionName = tool?.function?.name
  const value =
    typeof directName === 'string' && directName.trim().length > 0
      ? directName
      : typeof functionName === 'string' && functionName.trim().length > 0
        ? functionName
        : undefined
  return value
}

function readableAliasStem(originalName: string): string {
  let stem = originalName.replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_')
  if (!/^[A-Za-z]/.test(stem)) stem = `tool_${stem}`
  return stem || 'tool'
}

function generatedAlias(originalName: string, attempt: number): string {
  const digest = crypto
    .createHash('sha256')
    .update(attempt === 0 ? originalName : `${originalName}\0${attempt}`)
    .digest('hex')
    .slice(0, 32)
  const stem = readableAliasStem(originalName).slice(0, 31)
  return `${stem}_${digest}`
}

/**
 * Builds a request-scoped registry. Keeping this state off global/SDK-client caches prevents
 * concurrent requests from restoring an alias with another request's tool namespace.
 */
export function createToolNameRegistry(tools: unknown = []): ToolNameRegistry {
  const originalToWire = new Map<string, string>()
  const wireToOriginal = new Map<string, string>()
  const toolList = Array.isArray(tools) ? tools : []

  const register = (originalName: string): string => {
    const existing = originalToWire.get(originalName)
    if (existing) return existing

    if (SAFE_TOOL_NAME_PATTERN.test(originalName) && !wireToOriginal.has(originalName)) {
      originalToWire.set(originalName, originalName)
      wireToOriginal.set(originalName, originalName)
      return originalName
    }

    for (let attempt = 0; attempt < 1024; attempt += 1) {
      const alias = generatedAlias(originalName, attempt)
      const aliasOwner = wireToOriginal.get(alias)
      if (!aliasOwner || aliasOwner === originalName) {
        originalToWire.set(originalName, alias)
        wireToOriginal.set(alias, originalName)
        return alias
      }
    }

    throw new Error(`Unable to allocate a unique CodeWhisperer alias for tool: ${originalName}`)
  }

  const originalNames = Array.from(
    new Set(toolList.map(getToolOriginalName).filter((name): name is string => name !== undefined))
  )

  // Reserve already-valid names first so generated aliases can never shadow them.
  for (const name of originalNames.filter((value) => SAFE_TOOL_NAME_PATTERN.test(value)).sort()) {
    register(name)
  }
  for (const name of originalNames.filter((value) => !SAFE_TOOL_NAME_PATTERN.test(value)).sort()) {
    register(name)
  }

  return {
    toWire: register,
    toOriginalMap(): ToolNameMap {
      return Object.freeze(Object.fromEntries(wireToOriginal.entries()))
    }
  }
}

export function restoreToolName(name: string, toolNameMap?: ToolNameMap): string {
  return toolNameMap && Object.prototype.hasOwnProperty.call(toolNameMap, name)
    ? (toolNameMap[name] ?? name)
    : name
}

function normalizeSchemaType(type: unknown): string | undefined {
  const candidates = Array.isArray(type) ? type : [type]
  for (const candidate of candidates) {
    if (candidate === 'integer') return 'number'
    if (typeof candidate === 'string' && SUPPORTED_SCHEMA_TYPES.has(candidate)) return candidate
  }
  return undefined
}

function isNullOnlySchema(value: unknown): boolean {
  if (!isRecord(value)) return false
  const types = Array.isArray(value.type) ? value.type : [value.type]
  return types.length > 0 && types.every((type) => type === 'null')
}

function sanitizeEnum(value: unknown): Array<string | number | boolean> | undefined {
  if (!Array.isArray(value)) return undefined
  const sanitized = value.filter(
    (item): item is string | number | boolean =>
      typeof item === 'string' ||
      typeof item === 'boolean' ||
      (typeof item === 'number' && Number.isFinite(item))
  )
  return sanitized.length > 0 ? sanitized : undefined
}

function resolveLocalReference(root: JsonObject, reference: unknown): JsonObject | undefined {
  if (typeof reference !== 'string' || !reference.startsWith('#/')) return undefined

  let pointer: string
  try {
    pointer = decodeURIComponent(reference.slice(2))
  } catch {
    return undefined
  }

  let current: unknown = root
  for (const rawSegment of pointer.split('/')) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~')
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment))
      return undefined
    current = current[segment]
  }
  return isRecord(current) ? current : undefined
}

function mergeSchemas(base: JsonObject, overlay: JsonObject): JsonObject {
  const merged: JsonObject = { ...base, ...overlay }

  if (isRecord(base.properties) || isRecord(overlay.properties)) {
    merged.properties = Object.fromEntries([
      ...Object.entries(isRecord(base.properties) ? base.properties : {}),
      ...Object.entries(isRecord(overlay.properties) ? overlay.properties : {})
    ])
  }

  const required = [
    ...(Array.isArray(base.required) ? base.required : []),
    ...(Array.isArray(overlay.required) ? overlay.required : [])
  ]
  if (required.length > 0) merged.required = Array.from(new Set(required))

  return merged
}

function schemaFingerprint(value: unknown): string {
  const canonicalize = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(canonicalize)
    if (!isRecord(current)) return current
    return Object.fromEntries(
      Object.keys(current)
        .sort()
        .map((key) => [key, canonicalize(current[key])])
    )
  }

  return JSON.stringify(canonicalize(value))
}

function finalizeSchema(schema: JsonObject): JsonObject {
  const output: JsonObject = { ...schema }

  if (isRecord(output.properties)) {
    output.properties = Object.fromEntries(Object.entries(output.properties))
    if (!output.type) output.type = 'object'

    const propertyNames = new Set(Object.keys(output.properties))
    const required = Array.isArray(output.required)
      ? Array.from(
          new Set(output.required.filter((name): name is string => typeof name === 'string'))
        ).filter((name) => propertyNames.has(name))
      : []
    if (required.length > 0) output.required = required
    else delete output.required
  } else {
    delete output.required
    if (output.type === 'object') output.properties = {}
  }

  return output
}

function sanitizeSchemaNode(
  value: unknown,
  root: JsonObject,
  depth: number,
  ancestors: WeakSet<object>
): JsonObject {
  if (!isRecord(value) || depth >= CODEWHISPERER_SCHEMA_MAX_DEPTH || ancestors.has(value)) {
    return {}
  }

  ancestors.add(value)
  try {
    const base: JsonObject = {}
    const normalizedType = normalizeSchemaType(value.type)
    if (normalizedType) base.type = normalizedType

    const description = truncateCodePoints(value.description, CODEWHISPERER_DESCRIPTION_MAX_LENGTH)
    if (description) base.description = description

    const enumValues = sanitizeEnum(value.enum)
    if (enumValues) base.enum = enumValues

    if (isRecord(value.properties)) {
      base.properties = Object.fromEntries(
        Object.entries(value.properties).map(([name, child]) => [
          name,
          sanitizeSchemaNode(child, root, depth + 1, ancestors)
        ])
      )
      base.type = 'object'
    }

    if (Array.isArray(value.required)) {
      base.required = value.required.filter((name): name is string => typeof name === 'string')
    }

    if (!isRecord(value.properties) && value.items !== undefined) {
      base.items = sanitizeSchemaNode(value.items, root, depth + 1, ancestors)
      base.type = 'array'
    }

    let result = base

    const referenced = resolveLocalReference(root, value.$ref)
    if (referenced) {
      result = mergeSchemas(sanitizeSchemaNode(referenced, root, depth + 1, ancestors), result)
    }

    if (Array.isArray(value.allOf) && value.allOf.length > 0) {
      const parts = value.allOf.map((part) => sanitizeSchemaNode(part, root, depth + 1, ancestors))
      const objectParts = [result, ...parts].filter(
        (part) => part.type === 'object' || isRecord(part.properties)
      )
      if (objectParts.length > 0) {
        result = objectParts.reduce((merged, part) => mergeSchemas(merged, part), {})
        result = mergeSchemas(result, base)
        result.type = 'object'
      } else {
        const firstUseful = parts.find((part) => Object.keys(part).length > 0)
        if (firstUseful) result = mergeSchemas(firstUseful, result)
      }
    }

    const alternatives = Array.isArray(value.anyOf)
      ? value.anyOf
      : Array.isArray(value.oneOf)
        ? value.oneOf
        : undefined
    if (alternatives?.length) {
      const candidates = alternatives
        .filter((part) => !isNullOnlySchema(part))
        .map((part) => sanitizeSchemaNode(part, root, depth + 1, ancestors))
      const hasUnrepresentableBranch = candidates.some(
        (candidate) => Object.keys(candidate).length === 0
      )
      const uniqueCandidates = Array.from(
        new Map(
          candidates
            .filter((candidate) => Object.keys(candidate).length > 0)
            .map((candidate) => [schemaFingerprint(candidate), candidate])
        ).values()
      )

      // CodeWhisperer's schema subset cannot express true unions. Preserve nullable or
      // duplicate-equivalent forms; otherwise retain only the parent constraints rather than
      // arbitrarily narrowing the tool to the first alternative.
      if (!hasUnrepresentableBranch && uniqueCandidates.length === 1) {
        result = mergeSchemas(uniqueCandidates[0]!, result)
      }
    }

    return finalizeSchema(result)
  } finally {
    ancestors.delete(value)
  }
}

/**
 * Reduces modern JSON Schema to CodeWhisperer's conservative supported subset. Local references
 * and common composites are flattened before unsupported keywords are discarded.
 */
export function sanitizeCodeWhispererSchema(schema: unknown): JsonObject {
  const root = isRecord(schema) ? schema : {}
  const sanitized = sanitizeSchemaNode(root, root, 0, new WeakSet())

  if (sanitized.type !== 'object') return { type: 'object', properties: {} }
  if (!isRecord(sanitized.properties)) sanitized.properties = {}
  return sanitized
}

export function convertToolsToCodeWhisperer(
  tools: unknown,
  registry: ToolNameRegistry = createToolNameRegistry(tools)
) {
  const toolList = Array.isArray(tools) ? tools : []
  const converted: any[] = []
  const seenNames = new Set<string>()

  for (const tool of toolList) {
    const originalName = getToolOriginalName(tool)
    if (!originalName) continue

    const wireName = registry.toWire(originalName)
    if (seenNames.has(wireName)) continue
    seenNames.add(wireName)

    const description = truncateCodePoints(
      tool?.description ?? tool?.function?.description ?? '',
      CODEWHISPERER_DESCRIPTION_MAX_LENGTH
    )
    const inputSchema = tool?.input_schema ?? tool?.function?.parameters ?? {}

    converted.push({
      toolSpecification: {
        name: wireName,
        description,
        inputSchema: { json: sanitizeCodeWhispererSchema(inputSchema) }
      }
    })
  }

  return converted
}

export function deduplicateToolResults(toolResults: any[]): any[] {
  const unique: any[] = []
  const seen = new Set()
  for (const toolResult of toolResults) {
    if (!seen.has(toolResult.toolUseId)) {
      seen.add(toolResult.toolUseId)
      unique.push(toolResult)
    }
  }
  return unique
}

export function deduplicateToolCallsByContent(toolCalls: any[]): any[] {
  const seen = new Set<string>()
  const unique: any[] = []
  for (const tc of toolCalls) {
    // \x00 as separator (can't appear in a tool name)
    const name = tc.name || tc.function?.name || ''
    const input = tc.input || tc.function?.arguments || ''
    const key = `${name}\x00${typeof input === 'string' ? input : JSON.stringify(input)}`
    if (!seen.has(key)) {
      seen.add(key)
      unique.push(tc)
    }
  }
  return unique
}
