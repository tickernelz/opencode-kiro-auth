import { MODEL_MAPPING, SUPPORTED_MODELS } from '../constants';

export function resolveKiroModel(model: string): string {
  const resolved = MODEL_MAPPING[model];
  if (!resolved) {
    throw new Error(
      `Unsupported model: ${model}. Supported models: ${SUPPORTED_MODELS.join(', ')}`
    );
  }
  return resolved;
}

export function getSupportedModels(): string[] {
  return SUPPORTED_MODELS;
}

export function isModelSupported(model: string): boolean {
  return SUPPORTED_MODELS.includes(model);
}
