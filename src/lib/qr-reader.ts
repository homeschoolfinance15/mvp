/** Decode camera frames locally, including browsers without BarcodeDetector. */
export async function createQrReader() {
  const { default: jsQR } = await import('jsqr')
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Camera image processing is unavailable.')
  return (video: HTMLVideoElement): string | null => {
    if (!video.videoWidth || !video.videoHeight || video.readyState < 2) return null
    const scale = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight))
    const width = Math.max(1, Math.round(video.videoWidth * scale))
    const height = Math.max(1, Math.round(video.videoHeight * scale))
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }
    context.drawImage(video, 0, 0, width, height)
    const pixels = context.getImageData(0, 0, width, height)
    return jsQR(pixels.data, width, height)?.data ?? null
  }
}
