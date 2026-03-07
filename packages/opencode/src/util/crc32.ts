const TABLE: number[] = []

for (let i = 0; i < 256; i++) {
  let c = i
  for (let j = 0; j < 8; j++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  TABLE[i] = c >>> 0
}

export function crc32(str: string): number {
  let crc = 0xffffffff
  const bytes = new TextEncoder().encode(str)

  for (let i = 0; i < bytes.length; i++) {
    crc = TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  }

  return (crc ^ 0xffffffff) >>> 0
}
