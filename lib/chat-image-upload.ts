import { compressChatImage } from "@/lib/compress-image"

/** Max images attached to one chat message. */
export const MAX_PENDING_IMAGES = 3

export type PendingChatImage = { dataUrl: string; name?: string; compressed?: boolean }

/** Allow large camera / screenshot files; compression runs before send. */
export const MAX_CHAT_INPUT_FILE_BYTES = 15 * 1024 * 1024

const ACCEPTED_MIMES = new Set(["image/png", "image/jpeg", "image/webp"])

function isAcceptedImageFile(file: File): boolean {
  if (ACCEPTED_MIMES.has(file.type)) return true
  if (/\.(png|jpe?g|webp)$/i.test(file.name)) return true
  // Clipboard screenshots often have an empty MIME type.
  if (!file.type && file.size > 0) return true
  return false
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ""))
    reader.onerror = () => reject(reader.error ?? new Error("read failed"))
    reader.readAsDataURL(file)
  })
}

async function prepareOneImage(
  file: File
): Promise<PendingChatImage | null> {
  if (file.size > MAX_CHAT_INPUT_FILE_BYTES) {
    throw new Error(
      `"${file.name || "image"}" is over 15 MB. Use a smaller file.`
    )
  }

  const raw = await readFileAsDataUrl(file)
  if (!raw.startsWith("data:image/")) {
    return null
  }

  const { dataUrl, compressed } = await compressChatImage(raw)
  return {
    dataUrl,
    name: file.name || undefined,
    compressed,
  }
}

export type PrepareChatImagesResult = {
  images: PendingChatImage[]
  compressedCount: number
  skipped: number
  error?: string
}

/**
 * Read, validate, and compress files for chat attachment (upload or paste).
 */
export async function prepareChatImagesFromFiles(
  files: FileList | File[],
  maxCount: number
): Promise<PrepareChatImagesResult> {
  const list = Array.from(files).filter(isAcceptedImageFile).slice(0, maxCount)
  if (list.length === 0) {
    return { images: [], compressedCount: 0, skipped: 0 }
  }

  const images: PendingChatImage[] = []
  let compressedCount = 0
  let skipped = 0
  let error: string | undefined

  for (const file of list) {
    try {
      const prepared = await prepareOneImage(file)
      if (!prepared) {
        skipped++
        continue
      }
      if (prepared.compressed) compressedCount++
      images.push(prepared)
    } catch (e) {
      skipped++
      error = e instanceof Error ? e.message : "Could not prepare image."
    }
  }

  return { images, compressedCount, skipped, error }
}
