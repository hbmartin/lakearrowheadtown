import { validImageMetadata, type ImageMetadata } from './image-metadata';

export const THUMBNAIL_EDGES = [96, 160, 192, 288, 320, 480] as const;
export const OWNED_IMAGE_PATH = /^\/images\/([a-f0-9]{64})\.(jpg|png|webp|gif)$/;
export const THUMBNAIL_PATH = /^\/thumbnails\/v1\/([a-f0-9]{64})\.(jpg|png|webp|gif)\/(96|160|192|288|320|480)$/;

// Request an exact integer width so every srcset descriptor matches the encoder.
// The height follows the source ratio, including EXIF orientation, without a crop.
export function thumbnailWidth(size: Pick<ImageMetadata, 'width' | 'height'>, edge: number): number {
  return Math.max(1, Math.floor(size.width * Math.min(1, edge / Math.max(size.width, size.height))));
}

export function responsiveThumbnail(url: string, origin: string, size?: ImageMetadata): { src: string; srcset: string; sizes: string } | undefined {
  if (!size || !validImageMetadata(size)) return;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return; }
  const match = OWNED_IMAGE_PATH.exec(parsed.pathname);
  if (parsed.origin !== origin || parsed.username || parsed.password || parsed.search || parsed.hash || !match) return;
  const base = `${origin}/thumbnails/v1/${match[1]}.${match[2]}`;
  const seen = new Set<number>();
  const candidates = THUMBNAIL_EDGES.flatMap(edge => {
    const width = thumbnailWidth(size, edge);
    if (seen.has(width)) return [];
    seen.add(width);
    return [`${base}/${edge} ${width}w`];
  });
  const displayWidth = (edge: number) => Number((size.width * Math.min(1, edge / Math.max(size.width, size.height))).toFixed(4));
  return {
    src: `${base}/160`, srcset: candidates.join(', '),
    sizes: `(max-width: 600px) ${displayWidth(96)}px, ${displayWidth(160)}px`,
  };
}
