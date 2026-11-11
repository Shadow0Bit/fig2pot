/**
 * Image assets → Penpot file media, registered lazily on first use so that
 * unused assets do not bloat the file.
 */
import type * as ir from '../ir.ts';
import type { BakeCache, BakedImage } from './bake.ts';
import { MAX_VARIANTS } from './downsample.ts';
import { penpotId } from './ids.ts';
import type { BuildContext, PenpotImageColor } from './library.ts';

export type MediaImage = Omit<PenpotImageColor, 'keepAspectRatio' | 'transform'>;

type Warn = (code: string, message: string, node?: Pick<ir.BaseNode, 'id' | 'name'>) => void;

export class MediaRegistry {
  private readonly builder: BuildContext;
  private readonly images: Record<string, ir.ImageAsset>;
  private readonly warn: Warn;
  private readonly cache: BakeCache;
  /** `null` remembers assets that could not be registered. */
  private readonly registered = new Map<string, MediaImage | null>();
  private readonly baked = new Map<string, MediaImage | null>();
  /** Reduced copies by `ref` → `<width>x<height>` (`downsample.ts`). */
  private readonly variants = new Map<string, Map<string, MediaImage | null>>();

  constructor(builder: BuildContext, images: Record<string, ir.ImageAsset>, warn: Warn, cache: BakeCache) {
    this.builder = builder;
    this.images = images;
    this.warn = warn;
    this.cache = cache;
  }

  /** The Penpot image for an asset, or undefined (with a warning) when it cannot be used. */
  image(ref: string, node?: Pick<ir.BaseNode, 'id' | 'name'>): MediaImage | undefined {
    const cached = this.registered.get(ref);
    if (cached !== undefined) {
      if (cached === null) this.warn('missing-image', `Image ${ref} is unavailable; its fill was dropped`, node);
      return cached ?? undefined;
    }
    const image = this.register(ref, node);
    this.registered.set(ref, image ?? null);
    return image;
  }

  /** The Penpot image for a baked bitmap; one media object per distinct bitmap. */
  bakedImage(image: BakedImage, node?: Pick<ir.BaseNode, 'id' | 'name'>): MediaImage | undefined {
    const cached = this.baked.get(image.key);
    if (cached !== undefined) return cached ?? undefined;
    let media: MediaImage | undefined;
    const name = `baked-${image.key.slice(0, 12)}`;
    try {
      const id = this.builder.addFileMedia(
        { id: penpotId(image.key, 'baked-media'), name, width: image.width, height: image.height },
        new Blob([image.png as Uint8Array<ArrayBuffer>], { type: 'image/png' }),
      );
      media = this.builder.getMediaAsImage(id) ?? { id, width: image.width, height: image.height, mtype: 'image/png', name };
    } catch (error) {
      this.warn('unsupported-image', `Penpot rejected a baked image: ${String(error)}`, node);
    }
    this.baked.set(image.key, media ?? null);
    return media;
  }

  /**
   * A reduced copy of an image (`downsample.ts`): one media object per (image, size), at most `MAX_VARIANTS`
   * sizes per image; undefined (use the original) beyond that or when the image cannot be decoded.
   */
  downsampled(ref: string, size: { width: number; height: number }, node?: Pick<ir.BaseNode, 'id' | 'name'>): MediaImage | undefined {
    let sizes = this.variants.get(ref);
    if (!sizes) this.variants.set(ref, (sizes = new Map()));
    const key = `${size.width}x${size.height}`;
    const cached = sizes.get(key);
    if (cached !== undefined) return cached ?? undefined;
    if (!this.naturalSize(ref)) return undefined;
    if (sizes.size >= MAX_VARIANTS) {
      this.warn('image-variants-capped', `Image ${ref} is shown at more than ${MAX_VARIANTS} sizes; it is stored as reduced copies for ${MAX_VARIANTS} of them and at full size for the others`, undefined);
      return undefined;
    }
    let media: MediaImage | undefined;
    const bytes = this.cache.downsampled(ref, size.width, size.height);
    if (bytes) {
      const name = `${ref}@${key}`;
      try {
        const id = this.builder.addFileMedia(
          { id: penpotId(name, 'media'), name, width: size.width, height: size.height },
          new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/png' }),
        );
        media = this.builder.getMediaAsImage(id) ?? { id, width: size.width, height: size.height, mtype: 'image/png', name };
      } catch (error) {
        this.warn('unsupported-image', `Penpot rejected a reduced copy of image ${ref}; the original was used: ${String(error)}`, node);
      }
    }
    sizes.set(key, media ?? null);
    return media;
  }

  /**
   * One `images-downsampled` warning for the document, when reduced copies were stored: how many images,
   * whether their originals were left out, the bytes that saved, and the option that turns it off.
   */
  reportDownsampling(scale: number): void {
    let images = 0;
    let replaced = 0;
    let saved = 0;
    for (const [ref, sizes] of this.variants) {
      const stored = [...sizes].filter(([, media]) => media);
      if (stored.length === 0) continue;
      images++;
      const copies = stored.reduce((n, [key]) => {
        const [w, h] = key.split('x').map(Number) as [number, number];
        return n + this.cache.downsampledBytes(ref, w, h);
      }, 0);
      const asset = Object.hasOwn(this.images, ref) ? this.images[ref] : undefined;
      if (this.registered.has(ref) || !asset) saved -= copies;
      else {
        replaced++;
        saved += this.cache.media(asset).bytes.length - copies;
      }
    }
    if (images === 0) return;
    const mb = (n: number): string => `${(n / 1048576).toFixed(1)} MB`;
    this.warn(
      'images-downsampled',
      `${images} image${images === 1 ? ' is' : 's are'} shown much smaller than their size and ${images === 1 ? 'was' : 'were'} stored as reduced copies filtered like Figma's (for ${replaced} of them the full-size original is not stored: nothing shows it); ` +
        `the file is ${saved >= 0 ? `${mb(saved)} smaller` : `${mb(-saved)} larger`}. Zoomed in past ${scale}× they show less detail than the originals; use --no-downsample (downsampleImages: false) to keep only the originals`,
      undefined,
    );
  }

  /** The pixel size of a usable PNG / JPEG / … asset (what `image` would register), without registering it. */
  naturalSize(ref: string): { width: number; height: number } | undefined {
    const asset = Object.hasOwn(this.images, ref) ? this.images[ref] : undefined;
    if (!asset || asset.bytes.length === 0 || !asset.mimeType || asset.width === undefined || asset.height === undefined) return undefined;
    const width = Math.round(asset.width);
    const height = Math.round(asset.height);
    return width > 0 && height > 0 ? { width, height } : undefined;
  }

  private register(ref: string, node?: Pick<ir.BaseNode, 'id' | 'name'>): MediaImage | undefined {
    const asset = Object.hasOwn(this.images, ref) ? this.images[ref] : undefined;
    if (!asset || asset.bytes.length === 0) {
      this.warn('missing-image', `Image ${ref} is missing from the document; its fill was dropped`, node);
      return undefined;
    }
    const width = asset.width === undefined ? undefined : Math.round(asset.width);
    const height = asset.height === undefined ? undefined : Math.round(asset.height);
    if (!asset.mimeType || !width || !height || width <= 0 || height <= 0) {
      this.warn(
        'unsupported-image',
        `Image ${ref} has an unknown format or size; its fill was dropped`,
        node,
      );
      return undefined;
    }
    // Plain sRGB bytes, so that both renderers show the colours the source shows (`image-color.ts`).
    const prepared = this.cache.media(asset);
    if (prepared.unsupported !== undefined) {
      this.warn('image-profile-unsupported', `Image ${ref} has colour information that cannot be converted (${prepared.unsupported}); Penpot's renderers may show it differently`, node);
    }
    try {
      const id = this.builder.addFileMedia(
        { id: penpotId(ref, 'media'), name: ref, width, height },
        new Blob([prepared.bytes as Uint8Array<ArrayBuffer>], { type: asset.mimeType }),
      );
      return this.builder.getMediaAsImage(id) ?? { id, width, height, mtype: asset.mimeType, name: ref };
    } catch (error) {
      this.warn('unsupported-image', `Penpot rejected image ${ref}: ${String(error)}`, node);
      return undefined;
    }
  }
}
