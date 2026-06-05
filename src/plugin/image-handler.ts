interface UnifiedImage {
  mediaType: string
  data: string
}

export const MAX_KIRO_IMAGES = 4
export const MAX_KIRO_IMAGE_BYTES = 3_750_000

export interface KiroImage {
  format: string
  source: {
    bytes: Uint8Array
  }
}

interface ImageConversionResult {
  images: KiroImage[]
  omitted: number
}

/** Decode base64 to a plain Uint8Array (NOT Buffer) to avoid Buffer.toJSON() trap. */
function base64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return arr
}

function extractImagesFromAnthropicFormat(content: any[]): UnifiedImage[] {
  const images: UnifiedImage[] = []

  for (const item of content) {
    if (item.type === 'image' && item.source?.type === 'base64') {
      images.push({
        mediaType: item.source.media_type || 'image/jpeg',
        data: item.source.data
      })
    }
  }

  return images
}

function extractImagesFromOpenAI(content: any[]): UnifiedImage[] {
  const images: UnifiedImage[] = []

  for (const item of content) {
    if (item.type === 'image_url' && item.image_url?.url) {
      const url = item.image_url.url

      if (url.startsWith('data:')) {
        try {
          const [header, data] = url.split(',', 2)
          if (!data) continue

          const mediaType = header.split(';')[0].replace('data:', '')

          images.push({
            mediaType: mediaType || 'image/jpeg',
            data: data
          })
        } catch (e) {
          continue
        }
      }
    }
  }

  return images
}

export function extractAllImages(content: any): UnifiedImage[] {
  if (!Array.isArray(content)) return []

  return [...extractImagesFromAnthropicFormat(content), ...extractImagesFromOpenAI(content)]
}

export function convertImagesToKiroFormat(images: UnifiedImage[]): ImageConversionResult {
  const selected: UnifiedImage[] = []
  let totalBase64Chars = 0

  for (const img of images) {
    if (selected.length >= MAX_KIRO_IMAGES) break
    if (totalBase64Chars + img.data.length > MAX_KIRO_IMAGE_BYTES) break
    selected.push(img)
    totalBase64Chars += img.data.length
  }

  return {
    images: selected.map((img) => {
      const format = img.mediaType.split('/')[1] || 'png'
      return { format, source: { bytes: base64ToUint8Array(img.data) } }
    }),
    omitted: images.length - selected.length
  }
}

export function extractTextFromParts(parts: any[]): string {
  const textParts: string[] = []

  for (const part of parts) {
    if (part.text && typeof part.text === 'string') {
      textParts.push(part.text)
    } else if (part.type === 'text' && part.text) {
      textParts.push(part.text)
    }
  }

  return textParts.join('')
}
