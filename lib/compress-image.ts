/** Max base64 payload chars accepted by the chat API (see validation.ts). */
export const MAX_CHAT_IMAGE_BASE64_CHARS = 1_500_000

function base64PayloadLength(dataUrl: string): number {
  const marker = ";base64,"
  const idx = dataUrl.indexOf(marker)
  return idx >= 0 ? dataUrl.length - idx - marker.length : dataUrl.length
}

/** Resize image before upload - smaller = faster API calls. */
export async function compressChartImage(
  dataUrl: string,
  maxDimension = 900,
  quality = 0.72
): Promise<string> {
  if (typeof window === "undefined") return dataUrl

  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const longest = Math.max(img.width, img.height)
      const scale = Math.min(1, maxDimension / longest)
      const w = Math.round(img.width * scale)
      const h = Math.round(img.height * scale)
      const canvas = document.createElement("canvas")
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext("2d")
      if (!ctx) {
        resolve(dataUrl)
        return
      }
      ctx.drawImage(img, 0, 0, w, h)
      resolve(canvas.toDataURL("image/jpeg", quality))
    }
    img.onerror = () => reject(new Error("Failed to load image"))
    img.src = dataUrl
  })
}

/**
 * Compress chat attachments until they fit server limits.
 * Large screenshots / pasted PNGs are resized instead of rejected.
 */
export async function compressChatImage(
  dataUrl: string,
  targetBase64Chars = 900_000
): Promise<{ dataUrl: string; compressed: boolean }> {
  if (typeof window === "undefined") {
    return { dataUrl, compressed: false }
  }

  const withinLimit = (url: string) =>
    base64PayloadLength(url) <= targetBase64Chars &&
    base64PayloadLength(url) <= MAX_CHAT_IMAGE_BASE64_CHARS

  if (withinLimit(dataUrl)) {
    return { dataUrl, compressed: false }
  }

  let maxDimension = 1280
  let quality = 0.85
  let result = dataUrl
  let compressed = false

  for (let attempt = 0; attempt < 10; attempt++) {
    result = await compressChartImage(dataUrl, maxDimension, quality)
    compressed = true
    if (withinLimit(result)) {
      return { dataUrl: result, compressed }
    }
    quality -= 0.07
    if (quality < 0.42) {
      quality = 0.72
      maxDimension = Math.round(maxDimension * 0.72)
      if (maxDimension < 480) break
    }
  }

  if (!withinLimit(result)) {
    throw new Error(
      "Image is still too large after compression. Crop or use a smaller screenshot."
    )
  }

  return { dataUrl: result, compressed }
}
